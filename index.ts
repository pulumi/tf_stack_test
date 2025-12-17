import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// =============================================================================
// Configuration
// =============================================================================
const config = new pulumi.Config();
const awsRegion = config.get("aws:region") || "us-east-1";
const projectName = config.get("projectName") || "data-pipeline-test";
const environment = config.get("environment") || "dev";

// =============================================================================
// Data Sources
// =============================================================================
const current = aws.getCallerIdentity({});
const currentRegion = aws.getRegion({});

// =============================================================================
// S3 Bucket for Lambda Artifacts
// =============================================================================
const lambdaArtifactsBucket = new aws.s3.Bucket("lambda_artifacts", {
    bucket: pulumi.interpolate`${projectName}-lambda-artifacts-${current.then(c => c.accountId)}`,
    tags: {
        Purpose: "Lambda Deployment Artifacts",
    },
});

const lambdaArtifactsVersioning = new aws.s3.BucketVersioning("lambda_artifacts", {
    bucket: lambdaArtifactsBucket.id,
    versioningConfiguration: {
        status: "Enabled",
    },
});

const lambdaArtifactsEncryption = new aws.s3.BucketServerSideEncryptionConfiguration("lambda_artifacts", {
    bucket: lambdaArtifactsBucket.id,
    rules: [{
        applyServerSideEncryptionByDefault: {
            sseAlgorithm: "AES256",
        },
    }],
});

const lambdaArtifactsPublicAccessBlock = new aws.s3.BucketPublicAccessBlock("lambda_artifacts", {
    bucket: lambdaArtifactsBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
});

// =============================================================================
// Data Lake S3 Bucket (using individual resources instead of module)
// =============================================================================
const dataLakeBucket = new aws.s3.Bucket("this", {
    bucket: pulumi.interpolate`${projectName}-data-lake-${current.then(c => c.accountId)}`,
    tags: {
        Purpose: "Data Lake Storage",
    },
});

const dataLakeBucketOwnership = new aws.s3.BucketOwnershipControls("this", {
    bucket: dataLakeBucket.id,
    rule: {
        objectOwnership: "BucketOwnerEnforced",
    },
});

const dataLakeBucketVersioning = new aws.s3.BucketVersioning("this", {
    bucket: dataLakeBucket.id,
    versioningConfiguration: {
        status: "Enabled",
    },
});

const dataLakeBucketEncryption = new aws.s3.BucketServerSideEncryptionConfiguration("this", {
    bucket: dataLakeBucket.id,
    rules: [{
        applyServerSideEncryptionByDefault: {
            sseAlgorithm: "aws:kms",
        },
        bucketKeyEnabled: true,
    }],
});

const dataLakeBucketLifecycle = new aws.s3.BucketLifecycleConfiguration("this", {
    bucket: dataLakeBucket.id,
    rules: [{
        id: "transition-to-ia",
        status: "Enabled",
        transitions: [
            {
                days: 30,
                storageClass: "STANDARD_IA",
            },
            {
                days: 90,
                storageClass: "GLACIER",
            },
        ],
        noncurrentVersionExpiration: {
            noncurrentDays: 365,
        },
    }],
});

const dataLakeBucketPublicAccessBlock = new aws.s3.BucketPublicAccessBlock("this", {
    bucket: dataLakeBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
});

// =============================================================================
// SNS Topic for S3 Event Notifications
// =============================================================================
const s3NotificationsTopic = new aws.sns.Topic("s3_notifications", {
    name: pulumi.interpolate`${projectName}-s3-notifications`,
    tags: {
        Purpose: "S3 Event Notifications",
    },
});

const s3NotificationsTopicPolicy = new aws.sns.TopicPolicy("s3_notifications", {
    arn: s3NotificationsTopic.arn,
    policy: pulumi.all([s3NotificationsTopic.arn, dataLakeBucket.arn]).apply(([topicArn, bucketArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Sid: "AllowS3Publish",
                Effect: "Allow",
                Principal: {
                    Service: "s3.amazonaws.com",
                },
                Action: "sns:Publish",
                Resource: topicArn,
                Condition: {
                    ArnLike: {
                        "aws:SourceArn": bucketArn,
                    },
                },
            }],
        })
    ),
});

// =============================================================================
// SQS Queues for Processing
// =============================================================================
const dataProcessingDlq = new aws.sqs.Queue("data_processing_dlq", {
    name: pulumi.interpolate`${projectName}-data-processing-dlq`,
    messageRetentionSeconds: 1209600, // 14 days
    tags: {
        Purpose: "Dead Letter Queue",
    },
});

const dataProcessingQueue = new aws.sqs.Queue("data_processing", {
    name: pulumi.interpolate`${projectName}-data-processing`,
    visibilityTimeoutSeconds: 300,
    messageRetentionSeconds: 86400,
    receiveWaitTimeSeconds: 10,
    redrivePolicy: pulumi.jsonStringify({
        deadLetterTargetArn: dataProcessingDlq.arn,
        maxReceiveCount: 3,
    }),
    tags: {
        Purpose: "Data Processing Queue",
    },
});

const dataProcessingQueuePolicy = new aws.sqs.QueuePolicy("data_processing", {
    queueUrl: dataProcessingQueue.id,
    policy: pulumi.all([dataProcessingQueue.arn, s3NotificationsTopic.arn]).apply(([queueArn, topicArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Sid: "AllowSNSMessages",
                Effect: "Allow",
                Principal: {
                    Service: "sns.amazonaws.com",
                },
                Action: "sqs:SendMessage",
                Resource: queueArn,
                Condition: {
                    ArnEquals: {
                        "aws:SourceArn": topicArn,
                    },
                },
            }],
        })
    ),
});

const sqsSubscription = new aws.sns.TopicSubscription("sqs_subscription", {
    topic: s3NotificationsTopic.arn,
    protocol: "sqs",
    endpoint: dataProcessingQueue.arn,
});

// =============================================================================
// IAM Role for Lambda Function
// =============================================================================
const lambdaRole = new aws.iam.Role("lambda_role", {
    name: pulumi.interpolate`${projectName}-lambda-role`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "lambda.amazonaws.com",
            },
        }],
    }),
    tags: {
        Purpose: "Lambda Execution Role",
    },
});

const lambdaS3AccessPolicy = new aws.iam.RolePolicy("lambda_s3_access", {
    name: pulumi.interpolate`${projectName}-lambda-s3-access`,
    role: lambdaRole.id,
    policy: pulumi.all([dataLakeBucket.arn, dataProcessingQueue.arn, current, currentRegion]).apply(([bucketArn, queueArn, caller, region]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: [
                        "s3:GetObject",
                        "s3:PutObject",
                        "s3:DeleteObject",
                        "s3:ListBucket",
                    ],
                    Resource: [
                        bucketArn,
                        `${bucketArn}/*`,
                    ],
                },
                {
                    Effect: "Allow",
                    Action: [
                        "sqs:ReceiveMessage",
                        "sqs:DeleteMessage",
                        "sqs:GetQueueAttributes",
                    ],
                    Resource: queueArn,
                },
                {
                    Effect: "Allow",
                    Action: [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents",
                    ],
                    Resource: `arn:aws:logs:${region.name}:${caller.accountId}:*`,
                },
            ],
        })
    ),
});

// =============================================================================
// Lambda Function for Data Processing
// =============================================================================
const lambdaCode = `import json
import boto3

def handler(event, context):
    print(f"Received event: {json.dumps(event)}")
    
    s3_client = boto3.client('s3')
    
    for record in event.get('Records', []):
        body = json.loads(record['body'])
        message = json.loads(body.get('Message', '{}'))
        
        for s3_record in message.get('Records', []):
            bucket = s3_record['s3']['bucket']['name']
            key = s3_record['s3']['object']['key']
            print(f"Processing: s3://{bucket}/{key}")
    
    return {
        'statusCode': 200,
        'body': json.dumps('Processing complete')
    }`;

const dataProcessor = new aws.lambda.Function("data_processor", {
    name: pulumi.interpolate`${projectName}-data-processor`,
    role: lambdaRole.arn,
    handler: "lambda_function.handler",
    runtime: "python3.11",
    timeout: 60,
    memorySize: 256,
    code: new pulumi.asset.AssetArchive({
        "lambda_function.py": new pulumi.asset.StringAsset(lambdaCode),
    }),
    environment: {
        variables: {
            DATA_LAKE_BUCKET: dataLakeBucket.id,
            ENVIRONMENT: environment,
        },
    },
    tags: {
        Purpose: "Data Processing",
    },
});

const sqsTrigger = new aws.lambda.EventSourceMapping("sqs_trigger", {
    eventSourceArn: dataProcessingQueue.arn,
    functionName: dataProcessor.arn,
    batchSize: 10,
    enabled: true,
});

const lambdaLogGroup = new aws.cloudwatch.LogGroup("lambda_logs", {
    name: pulumi.interpolate`/aws/lambda/${dataProcessor.name}`,
    retentionInDays: 14,
    tags: {
        Purpose: "Lambda Logs",
    },
});

// =============================================================================
// DynamoDB Table for Metadata Tracking
// =============================================================================
const fileMetadataTable = new aws.dynamodb.Table("file_metadata", {
    name: pulumi.interpolate`${projectName}-file-metadata`,
    billingMode: "PAY_PER_REQUEST",
    hashKey: "file_id",
    rangeKey: "timestamp",
    attributes: [
        {
            name: "file_id",
            type: "S",
        },
        {
            name: "timestamp",
            type: "N",
        },
        {
            name: "status",
            type: "S",
        },
    ],
    globalSecondaryIndexes: [{
        name: "status-index",
        hashKey: "status",
        rangeKey: "timestamp",
        projectionType: "ALL",
    }],
    pointInTimeRecovery: {
        enabled: true,
    },
    tags: {
        Purpose: "File Metadata Tracking",
    },
});

// =============================================================================
// Outputs
// =============================================================================
export const dataLakeBucketName = dataLakeBucket.id;
export const dataLakeBucketArn = dataLakeBucket.arn;
export const lambdaArtifactsBucketName = lambdaArtifactsBucket.id;
export const lambdaFunctionArn = dataProcessor.arn;
export const sqsQueueUrl = dataProcessingQueue.url;
export const dynamodbTableName = fileMetadataTable.name;