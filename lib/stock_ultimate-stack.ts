import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { join } from "path";
import 'dotenv/config';
import { Bucket } from "aws-cdk-lib/aws-s3";
import { LambdaIntegration, RestApi } from "aws-cdk-lib/aws-apigateway";
import { LambdaInvoke, StepFunctionsStartExecution, CallAwsService, LambdaInvocationType } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Choice, Condition, DefinitionBody, Fail, Pass, Result, StateMachine, Succeed, Wait, WaitTime, TaskInput } from "aws-cdk-lib/aws-stepfunctions";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction, SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import { CfnClassifier, CfnCrawler, CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Database, S3Table, Schema, DataFormat } from '@aws-cdk/aws-glue-alpha';
import { CfnNamedQuery } from "aws-cdk-lib/aws-athena";
import { ALPACA_CONFIG } from "./configuration";


export class StockUltimateStack extends Stack {
  private readonly dockerImageAssetPath: string = join(__dirname, './lambda_functions');
  readonly saveToS3: TaskInput;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_API_SECRET) {
    //   throw new Error('Alpaca API keys are not set in .env file.');
    // }

    const bucket = new Bucket(this, 'StocksData', {
      bucketName: 'stock-ultimate-bucket',
      removalPolicy: RemovalPolicy.DESTROY,
      versioned: true,
    });

    // grant read-write permissions to the bucket
    bucket.grantReadWrite(new ServicePrincipal('s3.amazonaws.com'));

    // Create lambda function
    const stockNamesLambda = new DockerImageFunction(this, 'StockNamesLambda', {
      functionName: 'StockUltimateFunction',
      code: DockerImageCode.fromImageAsset(this.dockerImageAssetPath),
      description: `Created Stock Ultimate Lambda on ${new Date().toISOString()}`,
      timeout: Duration.seconds(300),
      memorySize: 1024,
      environment: {
        'ALPACA_API_KEY': ALPACA_CONFIG.Prod.ALPACA_API_KEY,
        'ALPACA_API_SECRET': ALPACA_CONFIG.Prod.ALPACA_API_SECRET,
        'BUCKET_NAME': bucket.bucketName,
      },
    });

    bucket.grantReadWrite(stockNamesLambda);

    stockNamesLambda.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [bucket.bucketArn + '/*'],
        effect: Effect.ALLOW,
      })
    )

    const apiTask = new LambdaInvoke(this, 'Invoke Step Function', {
      lambdaFunction: stockNamesLambda,
      outputPath: '$.Payload',
      // resultSelector: {
      //   "body.$": "States.StringToJson($.body)"
      // }
    });

    const invokeS3PutObject = new CallAwsService(this, 'InvokeS3PutObject', {
      service: 's3',
      action: 'putObject',
      resultPath: '$.Payload',
      parameters: {
        Bucket: bucket.bucketName,
        Key: `stocks_data/stock_assets_${new Date().getTime()}.json`,
        Body: TaskInput.fromJsonPathAt('$.body').value,
      },
      iamResources: ['*'],
      iamAction: 's3:PutObject',
    })


    const jobFailed = new Fail(this, 'Job Failed', {
      cause: 'Stock API Failed',
      error: 'Stock API Failed'
    });

    const finalStatus = new Succeed(this, 'Job Complete', {
      comment: 'Job is completed'
    });

    const internalError = new Fail(this, 'Internal Error', {
      cause: 'Internal Error',
      error: 'Internal Error'
    });

    apiTask.addRetry({
      errors: ['Stock API Failed'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: Duration.seconds(10),
    })


    const wait = new Wait(this, 'WaitCompile', {
      time: WaitTime.duration(Duration.seconds(1))
    })

    const definition = wait.next(apiTask).next(new Choice(this, 'Job Complete?')
      .when(Condition.numberEquals('$.statusCode', 400), jobFailed)
      .when(Condition.numberEquals('$.statusCode', 200), invokeS3PutObject)
      .otherwise(internalError))

    const stateMachineRole = new Role(this, 'StateMachineRole', {
      assumedBy: new ServicePrincipal('states.amazonaws.com'),
    });

    stateMachineRole.addToPolicy(new PolicyStatement({
      actions: ["s3:PutObject"],
      resources: [bucket.bucketArn + '/*'],
      effect: Effect.ALLOW,
    }))

    // Create a state machine
    const stateMachine = new StateMachine(this, 'StateMachine', {
      definitionBody: DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(5),
      stateMachineName: 'StockUltimateStateMachine',
      role: stateMachineRole,
    });

    // Create an EventBridge rule to trigger the State Machine every week
    new Rule(this, 'WeeklyTriggerRuleForStateMachine', {
      schedule: Schedule.cron({
        minute: '14',
        hour: '7',
        weekDay: 'WED',
        month: '*',
        year: '*',
      }),
      targets: [new SfnStateMachine(stateMachine)],
    })

    new CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn })

    // Create Glue database
    const stockDatabase = new Database(this, 'StockDatabase', {
      databaseName: 'stock-ultimate-dbb'
    });

    bucket.grantReadWrite(new ServicePrincipal('glue.amazonaws.com'));

    // Create Glue Crawler Role
    const glueCrawlerRole = new Role(this, 'GlueCrawlerRole', {
      assumedBy: new ServicePrincipal('glue.amazonaws.com'),
      description: 'Role assumed by AWS Glue Crawler',
    });

    bucket.grantRead(glueCrawlerRole);

    // Grant permissions to publish to CloudWatch Logs
    glueCrawlerRole.addToPolicy(new PolicyStatement({
      resources: ['*'],
      // effect: Effect.ALLOW,
      actions: [
        'glue:CreateDatabase',
        'glue:UpdateDatabase',
        'glue:CreateTable',
        'glue:UpdateTable',
        'glue:CreatePartition',
        'glue:UpdatePartition',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        's3:PutObject',
        's3:GetObject',
        's3:ListBucket',
        'glue:GetDatabase',
        'glue:GetTable',
      ],
    }));

    const customJsonClassifier = new CfnClassifier(this, 'CustomJsonClassifier', {
      jsonClassifier: {
        jsonPath: '$[*]',  // Process each JSON object within an array.
      },
    });
    

    // Define Glue Crawler
    const glueCrawler = new CfnCrawler(this, 'StockUltimateCrawler', {
      name: 'StockUltimateCrawler',
      role: glueCrawlerRole.roleArn,
      databaseName: stockDatabase.databaseName,
      tablePrefix: "stock-ultimate-",
      classifiers: [customJsonClassifier.ref],
      targets: {
        s3Targets: [{
          path: `s3://${bucket.bucketName}/assets/`  // path where the JSON files are stored
        }],
      },
      schedule: {
        scheduleExpression: 'cron(14 14 ? * WED *)'
      },
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'DEPRECATE_IN_DATABASE',
      },
    });
    // glueCrawler.addPropertyOverride('CustomJsonClassifier', customJsonClassifier.ref);
    // glueCrawler.node.addDependency(glueTable);

    // grant read-write permissions to the bucket
    bucket.grantReadWrite(new ServicePrincipal('athena.amazonaws.com'));
  }

}