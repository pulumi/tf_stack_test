import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from "fs";

// Get current AWS account and region
const current = aws.getCallerIdentity({});
const currentRegion = aws.getRegion({});

// Configuration
const config = new pulumi.Config();
const projectName = config.get("projectName") || "data-pipeline-test";
const environment = config.get("environment") || "dev";
const awsRegion = config.get("awsRegion") || "us-east-1";

// Tags to apply to all resources
const defaultTags = {
    Project: projectName,
    Environment: environment,
    ManagedBy: "Terraform",
};

// =============================================================================
// S3 Bucket - Data Lake (from module)
// =============================================================================
const dataLakeBucket = new aws.s3.Bucket("this", {
    bucket: pulumi.interpolate`${projectName}-data-lake-${current.then(c => c.accountId)}`,
    tags: {
        ...defaultTags,
        Purpose: "Data Lake Storage",
    },
}, { protect: false });

const dataLakeBucketOwnership = new aws.s3.BucketOwnershipControls("this", {
    bucket: dataLakeBucket.id,
    rule: {
        objectOwnership: "BucketOwnerEnforced",
    },
}, { protect: false });

const dataLakeBucketVersioning = new aws.s3.BucketVersioning("this", {
    bucket: dataLakeBucket.id,
    versioningConfiguration: {
        status: "Enabled",
    },
}, { protect: false });

const dataLakeBucketEncryption = new aws.s3.BucketServerSideEncryptionConfiguration("this", {
    bucket: dataLakeBucket.id,
    rules: [{
        applyServerSideEncryptionByDefault: {
            sseAlgorithm: "aws:kms",
        },
        bucketKeyEnabled: true,
    }],
}, { protect: false });

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
}, { protect: false });

const dataLakeBucketPublicAccessBlock = new aws.s3.BucketPublicAccessBlock("this", {
    bucket: dataLakeBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
}, { protect: false });

// =============================================================================
// S3 Bucket - Lambda Artifacts
// =============================================================================
const lambdaArtifactsBucket = new aws.s3.Bucket("lambda_artifacts", {
    bucket: pulumi.interpolate`${projectName}-lambda-artifacts-${current.then(c => c.accountId)}`,
    tags: {
        ...defaultTags,
        Purpose: "Lambda Deployment Artifacts",
    },
}, { protect: false });

const lambdaArtifactsVersioning = new aws.s3.BucketVersioning("lambda_artifacts", {
    bucket: lambdaArtifactsBucket.id,
    versioningConfiguration: {
        status: "Enabled",
    },
}, { protect: false });

const lambdaArtifactsEncryption = new aws.s3.BucketServerSideEncryptionConfiguration("lambda_artifacts", {
    bucket: lambdaArtifactsBucket.id,
    rules: [{
        applyServerSideEncryptionByDefault: {
            sseAlgorithm: "AES256",
        },
    }],
}, { protect: false });

const lambdaArtifactsPublicAccessBlock = new aws.s3.BucketPublicAccessBlock("lambda_artifacts", {
    bucket: lambdaArtifactsBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
}, { protect: false });

// =============================================================================
// SNS Topic for S3 Event Notifications
// =============================================================================
const s3NotificationsTopic = new aws.sns.Topic("s3_notifications", {
    name: `${projectName}-s3-notifications`,
    tags: {
        ...defaultTags,
        Purpose: "S3 Event Notifications",
    },
}, { protect: false });

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
}, { protect: false });

// =============================================================================
// SQS Queues
// =============================================================================
const dataProcessingDlq = new aws.sqs.Queue("data_processing_dlq", {
    name: `${projectName}-data-processing-dlq`,
    messageRetentionSeconds: 1209600, // 14 days
    tags: {
        ...defaultTags,
        Purpose: "Dead Letter Queue",
    },
}, { protect: false });

const dataProcessingQueue = new aws.sqs.Queue("data_processing", {
    name: `${projectName}-data-processing`,
    visibilityTimeoutSeconds: 300,
    messageRetentionSeconds: 86400,
    receiveWaitTimeSeconds: 10,
    redrivePolicy: pulumi.interpolate`{"deadLetterTargetArn":"${dataProcessingDlq.arn}","maxReceiveCount":3}`,
    tags: {
        ...defaultTags,
        Purpose: "Data Processing Queue",
    },
}, { protect: false });

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
}, { protect: false });

const sqsSubscription = new aws.sns.TopicSubscription("sqs_subscription", {
    topic: s3NotificationsTopic.arn,
    protocol: "sqs",
    endpoint: dataProcessingQueue.arn,
}, { protect: false });

// =============================================================================
// IAM Role for Lambda
// =============================================================================
const lambdaRole = new aws.iam.Role("lambda_role", {
    name: `${projectName}-lambda-role`,
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
        ...defaultTags,
        Purpose: "Lambda Execution Role",
    },
}, { protect: false });

const lambdaS3AccessPolicy = new aws.iam.RolePolicy("lambda_s3_access", {
    name: `${projectName}-lambda-s3-access`,
    role: lambdaRole.id,
    policy: pulumi.all([dataLakeBucket.arn, dataProcessingQueue.arn, currentRegion, current]).apply(
        ([bucketArn, queueArn, region, acct]) =>
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
                        Resource: `arn:aws:logs:${region.name}:${acct.accountId}:*`,
                    },
                ],
            })
    ),
}, { protect: false });

// =============================================================================
// Lambda Function
// =============================================================================
const lambdaFunction = new aws.lambda.Function("data_processor", {
    name: `${projectName}-data-processor`,
    role: lambdaRole.arn,
    handler: "lambda_function.handler",
    runtime: "python3.11",
    timeout: 60,
    memorySize: 256,
    code: new pulumi.asset.FileArchive("./lambda_function.zip"),
    environment: {
        variables: {
            DATA_LAKE_BUCKET: dataLakeBucket.id,
            ENVIRONMENT: environment,
        },
    },
    tags: {
        ...defaultTags,
        Purpose: "Data Processing",
    },
}, { protect: false });

const sqsTrigger = new aws.lambda.EventSourceMapping("sqs_trigger", {
    eventSourceArn: dataProcessingQueue.arn,
    functionName: lambdaFunction.arn,
    batchSize: 10,
    enabled: true,
}, { protect: false });

const lambdaLogGroup = new aws.cloudwatch.LogGroup("lambda_logs", {
    name: pulumi.interpolate`/aws/lambda/${lambdaFunction.name}`,
    retentionInDays: 14,
    tags: {
        ...defaultTags,
        Purpose: "Lambda Logs",
    },
}, { protect: false });

// =============================================================================
// DynamoDB Table
// =============================================================================
const fileMetadataTable = new aws.dynamodb.Table("file_metadata", {
    name: `${projectName}-file-metadata`,
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
        ...defaultTags,
        Purpose: "File Metadata Tracking",
    },
}, { protect: false });

// =============================================================================
// Outputs
// =============================================================================
export const dataLakeBucketName = dataLakeBucket.id;
export const dataLakeBucketArn = dataLakeBucket.arn;
export const lambdaArtifactsBucketName = lambdaArtifactsBucket.id;
export const lambdaFunctionArn = lambdaFunction.arn;
export const sqsQueueUrl = dataProcessingQueue.url;
export const dynamodbTableName = fileMetadataTable.name;
