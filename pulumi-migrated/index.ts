import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const config = new pulumi.Config();
const projectName = config.get("projectName") || "data-pipeline-test1";
const environment = config.get("environment") || "dev";

const callerIdentity = aws.getCallerIdentity();
const currentRegion = aws.getRegion();

const accountId = callerIdentity.then(id => id.accountId);
const regionName = currentRegion.then(r => r.name);

// Default tags applied by the Terraform provider; replicate via Pulumi's
// defaultTags provider option or set them explicitly on each resource.
const defaultTags: Record<string, string> = {
    Project: projectName,
    Environment: environment,
    ManagedBy: "Terraform",
};

// ---------------------------------------------------------------------------
// Data Lake S3 Bucket (was terraform-aws-modules/s3-bucket module)
// ---------------------------------------------------------------------------
const dataLakeBucket = new aws.s3.Bucket("data_lake_bucket_this[0]", {
    bucket: pulumi.interpolate`${projectName}-data-lake-${accountId}`,
    tags: {
        ...defaultTags,
        Purpose: "Data Lake Storage",
    },
});

const dataLakeBucketVersioning = new aws.s3.BucketVersioning("data_lake_bucket_this[0]", {
    bucket: dataLakeBucket.id,
    versioningConfiguration: {
        status: "Enabled",
    },
});

const dataLakeBucketEncryption = new aws.s3.BucketServerSideEncryptionConfiguration("data_lake_bucket_this[0]", {
    bucket: dataLakeBucket.id,
    rules: [{
        applyServerSideEncryptionByDefault: {
            sseAlgorithm: "aws:kms",
        },
        bucketKeyEnabled: true,
    }],
});

const dataLakeBucketLifecycle = new aws.s3.BucketLifecycleConfiguration("data_lake_bucket_this[0]", {
    bucket: dataLakeBucket.id,
    rules: [{
        id: "transition-to-ia",
        status: "Enabled",
        noncurrentVersionExpiration: {
            noncurrentDays: 365,
        },
        transitions: [
            { days: 30, storageClass: "STANDARD_IA" },
            { days: 90, storageClass: "GLACIER" },
        ],
    }],
});

const dataLakeBucketOwnership = new aws.s3.BucketOwnershipControls("data_lake_bucket_this[0]", {
    bucket: dataLakeBucket.id,
    rule: {
        objectOwnership: "BucketOwnerEnforced",
    },
});

const dataLakeBucketPublicAccess = new aws.s3.BucketPublicAccessBlock("data_lake_bucket_this[0]", {
    bucket: dataLakeBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
});

// ---------------------------------------------------------------------------
// Lambda Artifacts S3 Bucket
// ---------------------------------------------------------------------------
const lambdaArtifactsBucket = new aws.s3.Bucket("lambda_artifacts", {
    bucket: pulumi.interpolate`${projectName}-lambda-artifacts-${accountId}`,
    tags: {
        ...defaultTags,
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

const lambdaArtifactsPublicAccess = new aws.s3.BucketPublicAccessBlock("lambda_artifacts", {
    bucket: lambdaArtifactsBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
});

// ---------------------------------------------------------------------------
// SNS Topic for S3 Event Notifications
// ---------------------------------------------------------------------------
const snsNotifications = new aws.sns.Topic("s3_notifications", {
    name: `${projectName}-s3-notifications`,
    tags: {
        ...defaultTags,
        Purpose: "S3 Event Notifications",
    },
});

const snsTopicPolicy = new aws.sns.TopicPolicy("s3_notifications", {
    arn: snsNotifications.arn,
    policy: pulumi.all([snsNotifications.arn, dataLakeBucket.arn]).apply(([topicArn, bucketArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Sid: "AllowS3Publish",
                Effect: "Allow",
                Principal: { Service: "s3.amazonaws.com" },
                Action: "sns:Publish",
                Resource: topicArn,
                Condition: {
                    ArnLike: { "aws:SourceArn": bucketArn },
                },
            }],
        }),
    ),
});

// ---------------------------------------------------------------------------
// SQS Queues
// ---------------------------------------------------------------------------
const dlq = new aws.sqs.Queue("data_processing_dlq", {
    name: `${projectName}-data-processing-dlq`,
    messageRetentionSeconds: 1209600,
    tags: {
        ...defaultTags,
        Purpose: "Dead Letter Queue",
    },
});

const dataProcessingQueue = new aws.sqs.Queue("data_processing", {
    name: `${projectName}-data-processing`,
    visibilityTimeoutSeconds: 300,
    messageRetentionSeconds: 86400,
    receiveWaitTimeSeconds: 10,
    redrivePolicy: dlq.arn.apply(dlqArn =>
        JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: 3,
        }),
    ),
    tags: {
        ...defaultTags,
        Purpose: "Data Processing Queue",
    },
});

const sqsQueuePolicy = new aws.sqs.QueuePolicy("data_processing", {
    queueUrl: dataProcessingQueue.url,
    policy: pulumi.all([dataProcessingQueue.arn, snsNotifications.arn]).apply(([queueArn, topicArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Sid: "AllowSNSMessages",
                Effect: "Allow",
                Principal: { Service: "sns.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: queueArn,
                Condition: {
                    ArnEquals: { "aws:SourceArn": topicArn },
                },
            }],
        }),
    ),
});

const snsSubscription = new aws.sns.TopicSubscription("sqs_subscription", {
    topic: snsNotifications.arn,
    protocol: "sqs",
    endpoint: dataProcessingQueue.arn,
});

// ---------------------------------------------------------------------------
// IAM Role for Lambda
// ---------------------------------------------------------------------------
const lambdaRole = new aws.iam.Role("lambda_role", {
    name: `${projectName}-lambda-role`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
        }],
    }),
    tags: {
        ...defaultTags,
        Purpose: "Lambda Execution Role",
    },
});

const lambdaRolePolicy = new aws.iam.RolePolicy("lambda_s3_access", {
    name: `${projectName}-lambda-s3-access`,
    role: lambdaRole.id,
    policy: pulumi.all([dataLakeBucket.arn, dataProcessingQueue.arn, regionName, accountId]).apply(
        ([bucketArn, queueArn, region, acctId]) =>
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
                        Resource: [bucketArn, `${bucketArn}/*`],
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
                        Resource: `arn:aws:logs:${region}:${acctId}:*`,
                    },
                ],
            }),
    ),
});

// ---------------------------------------------------------------------------
// Lambda Function
// ---------------------------------------------------------------------------
const lambdaFunction = new aws.lambda.Function("data_processor", {
    name: `${projectName}-data-processor`,
    role: lambdaRole.arn,
    handler: "lambda_function.handler",
    runtime: "python3.11",
    timeout: 60,
    memorySize: 256,
    code: new pulumi.asset.AssetArchive({
        "lambda_function.py": new pulumi.asset.FileAsset("lambda/lambda_function.py"),
    }),
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
});

const sqsTrigger = new aws.lambda.EventSourceMapping("sqs_trigger", {
    eventSourceArn: dataProcessingQueue.arn,
    functionName: lambdaFunction.arn,
    batchSize: 10,
    enabled: true,
});

// ---------------------------------------------------------------------------
// CloudWatch Log Group
// ---------------------------------------------------------------------------
const lambdaLogGroup = new aws.cloudwatch.LogGroup("lambda_logs", {
    name: pulumi.interpolate`/aws/lambda/${lambdaFunction.name}`,
    retentionInDays: 14,
    tags: {
        ...defaultTags,
        Purpose: "Lambda Logs",
    },
});

// ---------------------------------------------------------------------------
// DynamoDB Table
// ---------------------------------------------------------------------------
const fileMetadataTable = new aws.dynamodb.Table("file_metadata", {
    name: `${projectName}-file-metadata`,
    billingMode: "PAY_PER_REQUEST",
    hashKey: "file_id",
    rangeKey: "timestamp",
    attributes: [
        { name: "file_id", type: "S" },
        { name: "timestamp", type: "N" },
        { name: "status", type: "S" },
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
});

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const dataLakeBucketName = dataLakeBucket.id;
export const dataLakeBucketArn = dataLakeBucket.arn;
export const lambdaArtifactsBucketName = lambdaArtifactsBucket.id;
export const lambdaFunctionArn = lambdaFunction.arn;
export const sqsQueueUrl = dataProcessingQueue.url;
export const dynamodbTableName = fileMetadataTable.name;
