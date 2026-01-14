import json
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
    }
