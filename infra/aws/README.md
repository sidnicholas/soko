# AWS scale target (§24, ADR-013)

Not deployed in V1. Templates land early so migration is not a rewrite:
ECS/Fargate, EventBridge/SQS, Aurora/RDS Postgres, ElastiCache, S3,
CloudFront/WAF, KMS/Secrets Manager, OpenSearch. Avoid Railway-specific logic.
