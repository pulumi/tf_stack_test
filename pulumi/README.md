# Pulumi Infrastructure - Migrated from Terraform

This Pulumi project was migrated from Terraform using the `pulumi-terraform-migrate` tool.

## Overview

This infrastructure deploys a data processing pipeline on AWS with the following components:

- **S3 Buckets**: Data lake storage and Lambda artifacts
- **Lambda Function**: Python-based data processor
- **SQS/SNS**: Message queue and notification system
- **DynamoDB**: Metadata tracking table
- **IAM**: Roles and policies for Lambda execution
- **CloudWatch**: Logging for Lambda function

## Prerequisites

- Node.js and npm
- Pulumi CLI
- AWS credentials configured for account 894850187425

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Select the stack:
   ```bash
   pulumi stack select dev
   ```

3. Configure AWS credentials (if not using ESC):
   ```bash
   export AWS_ACCESS_KEY_ID=<your-access-key>
   export AWS_SECRET_ACCESS_KEY=<your-secret-key>
   export AWS_REGION=us-east-1
   ```

4. Preview changes:
   ```bash
   pulumi preview
   ```

5. Deploy changes:
   ```bash
   pulumi up
   ```

## Configuration

The stack uses the following configuration values:

- `projectName`: data-pipeline-test
- `environment`: dev
- `awsRegion`: us-east-1
- `aws:region`: us-east-1

You can modify these values using:
```bash
pulumi config set <key> <value>
```

## Outputs

The stack exports the following outputs:

- `dataLakeBucketName`: Name of the data lake S3 bucket
- `dataLakeBucketArn`: ARN of the data lake S3 bucket
- `lambdaArtifactsBucketName`: Name of the Lambda artifacts bucket
- `lambdaFunctionArn`: ARN of the Lambda function
- `sqsQueueUrl`: URL of the SQS processing queue
- `dynamodbTableName`: Name of the DynamoDB metadata table

## Project Structure

```
.
├── index.ts                 # Main Pulumi program
├── lambda_function.py       # Lambda function code
├── lambda_function.zip      # Packaged Lambda deployment
├── Pulumi.yaml             # Project configuration
├── Pulumi.dev.yaml         # Stack configuration
├── package.json            # Node.js dependencies
├── tsconfig.json           # TypeScript configuration
├── MIGRATION_NOTES.md      # Detailed migration notes
└── README.md               # This file
```

## Migration Notes

This project was migrated from Terraform. See [MIGRATION_NOTES.md](./MIGRATION_NOTES.md) for detailed information about the migration process.

## Resources

- [Pulumi Documentation](https://www.pulumi.com/docs/)
- [Pulumi AWS Provider](https://www.pulumi.com/registry/packages/aws/)
- [Terraform to Pulumi Migration Guide](https://www.pulumi.com/docs/using-pulumi/adopting-pulumi/migrating-to-pulumi/from-terraform/)
