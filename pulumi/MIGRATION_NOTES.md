# Terraform to Pulumi Migration Notes

## Migration Summary

This document describes the migration of Terraform infrastructure to Pulumi using the `pulumi-terraform-migrate` tool.

## Steps Completed

1. **Initialized Pulumi Stack**: Created a new TypeScript Pulumi project in the `pulumi/` directory
   - Project name: `tf-stack-migrated`
   - Stack name: `dev`

2. **Ran Initial Deployment**: Created the empty stack in Pulumi Cloud

3. **Migrated Terraform State**: Used `pulumi plugin run terraform-migrate` to convert Terraform state to Pulumi format
   - Input: `/workspace/tf_stack_test/terraform.tfstate`
   - Output: `/tmp/pulumi-state.json`
   - Required providers: AWS v7.12.0

4. **Imported State**: Successfully imported 24 resources into the Pulumi stack using `pulumi stack import`

5. **Created Pulumi Program**: Developed a TypeScript program that matches the Terraform configuration

## Resources Migrated

The following AWS resources were successfully migrated:

### S3 Buckets
- **Data Lake Bucket** (`this`): Main data storage with versioning, KMS encryption, lifecycle rules
  - Bucket name: `data-pipeline-test-data-lake-894850187425`
  - Features: Versioning, KMS encryption, lifecycle transitions (30d → STANDARD_IA, 90d → GLACIER)
  
- **Lambda Artifacts Bucket** (`lambda_artifacts`): Storage for Lambda deployment packages
  - Bucket name: `data-pipeline-test-lambda-artifacts-894850187425`
  - Features: Versioning, AES256 encryption

### Messaging Infrastructure
- **SNS Topic** (`s3_notifications`): For S3 event notifications
- **SQS Queue** (`data_processing`): Main processing queue with DLQ
- **SQS DLQ** (`data_processing_dlq`): Dead letter queue for failed messages
- **SNS Subscription**: Connects SNS topic to SQS queue

### Compute
- **Lambda Function** (`data_processor`): Python 3.11 function for data processing
  - Handler: `lambda_function.handler`
  - Memory: 256 MB
  - Timeout: 60 seconds
  - Environment variables: DATA_LAKE_BUCKET, ENVIRONMENT

- **Lambda Event Source Mapping** (`sqs_trigger`): Connects SQS queue to Lambda

### IAM
- **IAM Role** (`lambda_role`): Execution role for Lambda function
- **IAM Role Policy** (`lambda_s3_access`): Grants S3, SQS, and CloudWatch Logs permissions

### Monitoring
- **CloudWatch Log Group** (`lambda_logs`): Lambda function logs with 14-day retention

### Database
- **DynamoDB Table** (`file_metadata`): Metadata tracking table
  - Hash key: `file_id` (String)
  - Range key: `timestamp` (Number)
  - GSI: `status-index` on `status` and `timestamp`
  - Features: Point-in-time recovery, PAY_PER_REQUEST billing

## Configuration

The following configuration values are set:

```yaml
aws:region: us-east-1
projectName: data-pipeline-test
environment: dev
awsRegion: us-east-1
```

## Known Limitations

### Preview Validation
The `pulumi_preview` tool requires AWS credentials for the account where the resources exist (account ID: 894850187425). The available credentials are for a different account (058607598222), which prevents running a live preview to validate the program against the actual infrastructure.

### Next Steps for Full Validation

To complete the validation and ensure zero diffs:

1. **Configure AWS Credentials**: Set up credentials for AWS account 894850187425
   - Option A: Use Pulumi ESC with OIDC for the correct account
   - Option B: Configure AWS credentials directly

2. **Run Preview**: Execute `pulumi preview` to identify any remaining diffs

3. **Refine Program**: Adjust the Pulumi program based on preview output to minimize diffs
   - Common areas that may need adjustment:
     - Default values that differ between Terraform and Pulumi
     - Resource property names (camelCase vs snake_case)
     - Computed values vs explicit values

4. **Validate**: Repeat preview until diffs are minimal (provider-level diffs are acceptable)

## Program Structure

The Pulumi program (`index.ts`) is organized as follows:

1. **Configuration**: Loads project settings and default tags
2. **Data Lake S3 Bucket**: Main bucket with all sub-resources (versioning, encryption, lifecycle, etc.)
3. **Lambda Artifacts S3 Bucket**: Secondary bucket with sub-resources
4. **SNS/SQS Infrastructure**: Topic, queues, policies, and subscriptions
5. **IAM Resources**: Role and policies for Lambda execution
6. **Lambda Function**: Function definition and event source mapping
7. **CloudWatch Logs**: Log group for Lambda
8. **DynamoDB Table**: Metadata tracking table
9. **Exports**: Stack outputs matching Terraform outputs

## TypeScript Validation

The program has been validated with TypeScript compiler:
- ✅ No type errors
- ✅ All imports resolved
- ✅ Correct property names and types

## Files Created

- `index.ts`: Main Pulumi program
- `lambda_function.py`: Lambda function code (matches Terraform)
- `lambda_function.zip`: Packaged Lambda deployment
- `Pulumi.yaml`: Project configuration
- `Pulumi.dev.yaml`: Stack configuration
- `package.json`: Node.js dependencies
- `tsconfig.json`: TypeScript configuration

## Terraform vs Pulumi Mapping

| Terraform Resource | Pulumi Resource | Logical Name |
|-------------------|-----------------|--------------|
| `module.data_lake_bucket` | `aws.s3.Bucket` + sub-resources | `this` |
| `aws_s3_bucket.lambda_artifacts` | `aws.s3.Bucket` | `lambda_artifacts` |
| `aws_sns_topic.s3_notifications` | `aws.sns.Topic` | `s3_notifications` |
| `aws_sqs_queue.data_processing` | `aws.sqs.Queue` | `data_processing` |
| `aws_sqs_queue.data_processing_dlq` | `aws.sqs.Queue` | `data_processing_dlq` |
| `aws_lambda_function.data_processor` | `aws.lambda.Function` | `data_processor` |
| `aws_iam_role.lambda_role` | `aws.iam.Role` | `lambda_role` |
| `aws_dynamodb_table.file_metadata` | `aws.dynamodb.Table` | `file_metadata` |

## Important Notes

1. **Resource Names**: The Pulumi program uses the same logical names as the imported state to ensure proper resource matching
2. **Auto-naming**: Physical resource names are explicitly set to match the existing infrastructure
3. **Tags**: All resources include the original Terraform tags (Project, Environment, ManagedBy)
4. **Dependencies**: Resource dependencies are properly expressed through Pulumi's output system
5. **State Import**: The state was successfully imported with all 24 resources

## Verification Checklist

- [x] Terraform state converted to Pulumi format
- [x] State imported into Pulumi stack
- [x] Pulumi program created matching Terraform configuration
- [x] TypeScript compilation successful
- [x] All resource types match imported state
- [x] All logical names match imported state
- [ ] Preview run successfully (blocked by AWS credentials)
- [ ] Diffs minimized (requires preview)
- [ ] Final validation complete (requires preview)
