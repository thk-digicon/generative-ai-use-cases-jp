import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Auth,
  Api,
  Web,
  Database,
  Rag,
  RagKnowledgeBase,
  Transcribe,
  CommonWebAcl,
  SpeechToSpeech,
  McpApi,
  AgentCore,
} from './construct';
import { CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Agent } from 'generative-ai-use-cases';
import { UseCaseBuilder } from './construct/use-case-builder';
import { ProcessedStackInput } from './stack-input';
import { allowS3AccessWithSourceIpCondition } from './utils/s3-access-policy';
import {
  InterfaceVpcEndpoint,
  IVpc,
  ISecurityGroup,
  SecurityGroup,
} from 'aws-cdk-lib/aws-ec2';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { AgentCoreStack } from './agent-core-stack';

export interface GenerativeAiUseCasesStackProps extends StackProps {
  readonly params: ProcessedStackInput;
  // RAG Knowledge Base
  readonly knowledgeBaseId?: string;
  readonly knowledgeBaseDataSourceBucketName?: string;
  // Agent
  readonly agents?: Agent[];
  // Agent Core
  readonly agentCoreStack?: AgentCoreStack;
  // Video Generation
  readonly videoBucketRegionMap: Record<string, string>;
  // Guardrail
  readonly guardrailIdentifier?: string;
  readonly guardrailVersion?: string;
  // WAF
  readonly webAclId?: string;
  // Custom Domain
  readonly cert?: ICertificate;
  // Image build environment
  readonly isSageMakerStudio: boolean;
  // Closed network
  readonly vpc?: IVpc;
  readonly apiGatewayVpcEndpoint?: InterfaceVpcEndpoint;
  readonly webBucket?: Bucket;
  readonly cognitoUserPoolProxyEndpoint?: string;
  readonly cognitoIdentityPoolProxyEndpoint?: string;
}

export class GenerativeAiUseCasesStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(
    scope: Construct,
    id: string,
    props: GenerativeAiUseCasesStackProps
  ) {
    super(scope, id, props);
    process.env.overrideWarningsEnabled = 'false';

    const params = props.params;

    // Common security group for saving ENI in Closed network mode
    let securityGroups: ISecurityGroup[] | undefined = undefined;
    if (props.vpc) {
      securityGroups = [
        new SecurityGroup(this, 'LambdaSeurityGroup', {
          vpc: props.vpc,
          description: 'GenU Lambda Security Group',
          allowAllOutbound: true,
        }),
      ];
    }

    // Auth
    const auth = new Auth(this, 'Auth', {
      selfSignUpEnabled: params.selfSignUpEnabled,
      allowedIpV4AddressRanges: params.allowedIpV4AddressRanges,
      allowedIpV6AddressRanges: params.allowedIpV6AddressRanges,
      allowedSignUpEmailDomains: params.allowedSignUpEmailDomains,
      samlAuthEnabled: params.samlAuthEnabled,
    });

    // Database
    const database = new Database(this, 'Database');

    // API
    const api = new Api(this, 'API', {
      modelRegion: params.modelRegion,
      modelIds: params.modelIds,
      imageGenerationModelIds: params.imageGenerationModelIds,
      videoGenerationModelIds: params.videoGenerationModelIds,
      videoBucketRegionMap: props.videoBucketRegionMap,
      endpointNames: params.endpointNames,
      customAgents: params.agents,
      queryDecompositionEnabled: params.queryDecompositionEnabled,
      rerankingModelId: params.rerankingModelId,
      crossAccountBedrockRoleArn: params.crossAccountBedrockRoleArn,
      allowedIpV4AddressRanges: params.allowedIpV4AddressRanges,
      allowedIpV6AddressRanges: params.allowedIpV6AddressRanges,
      additionalS3Buckets: props.agentCoreStack?.fileBucket
        ? [props.agentCoreStack.fileBucket]
        : undefined,
      userPool: auth.userPool,
      idPool: auth.idPool,
      userPoolClient: auth.client,
      table: database.table,
      statsTable: database.statsTable,
      knowledgeBaseId: params.ragKnowledgeBaseId || props.knowledgeBaseId,
      agents: props.agents,
      guardrailIdentify: props.guardrailIdentifier,
      guardrailVersion: props.guardrailVersion,
      vpc: props.vpc,
      securityGroups,
      apiGatewayVpcEndpoint: props.apiGatewayVpcEndpoint,
      cognitoUserPoolProxyEndpoint: props.cognitoUserPoolProxyEndpoint,
    });

    // WAF
    if (
      params.allowedIpV4AddressRanges ||
      params.allowedIpV6AddressRanges ||
      params.allowedCountryCodes
    ) {
      const regionalWaf = new CommonWebAcl(this, 'RegionalWaf', {
        scope: 'REGIONAL',
        allowedIpV4AddressRanges: params.allowedIpV4AddressRanges,
        allowedIpV6AddressRanges: params.allowedIpV6AddressRanges,
        allowedCountryCodes: params.allowedCountryCodes,
      });
      new CfnWebACLAssociation(this, 'ApiWafAssociation', {
        resourceArn: api.api.deploymentStage.stageArn,
        webAclArn: regionalWaf.webAclArn,
      });
      new CfnWebACLAssociation(this, 'UserPoolWafAssociation', {
        resourceArn: auth.userPool.userPoolArn,
        webAclArn: regionalWaf.webAclArn,
      });
    }

    // SpeechToSpeech (for bidirectional communication)
    const speechToSpeech = new SpeechToSpeech(this, 'SpeechToSpeech', {
      envSuffix: params.env,
      api: api.api,
      userPool: auth.userPool,
      speechToSpeechModelIds: params.speechToSpeechModelIds,
      crossAccountBedrockRoleArn: params.crossAccountBedrockRoleArn,
      vpc: props.vpc,
      securityGroups,
    });

    // MCP
    let mcpEndpoint: string | null = null;
    if (params.mcpEnabled) {
      const mcpApi = new McpApi(this, 'McpApi', {
        idPool: auth.idPool,
        isSageMakerStudio: props.isSageMakerStudio,
        fileBucket: api.fileBucket,
        vpc: props.vpc,
        securityGroups,
      });
      mcpEndpoint = mcpApi.endpoint;
    }

    // AgentCore Runtime (External runtimes and permissions only)
    let genericRuntimeArn: string | undefined;
    let genericRuntimeName: string | undefined;

    // Get generic runtime info from AgentCore stack if it exists
    if (props.agentCoreStack) {
      genericRuntimeArn = props.agentCoreStack.deployedGenericRuntimeArn;
      genericRuntimeName = props.agentCoreStack.getGenericRuntimeConfig()?.name;
    }

    // Create AgentCore construct for external runtimes and permissions
    if (params.agentCoreExternalRuntimes.length > 0 || genericRuntimeArn) {
      new AgentCore(this, 'AgentCore', {
        agentCoreExternalRuntimes: params.agentCoreExternalRuntimes,
        idPool: auth.idPool,
        genericRuntimeArn,
        genericRuntimeName,
      });
    }

    // Web Frontend
    const web = new Web(this, 'Api', {
      // Auth
      userPoolId: auth.userPool.userPoolId,
      userPoolClientId: auth.client.userPoolClientId,
      idPoolId: auth.idPool.identityPoolId,
      selfSignUpEnabled: params.selfSignUpEnabled,
      samlAuthEnabled: params.samlAuthEnabled,
      samlCognitoDomainName: params.samlCognitoDomainName,
      samlCognitoFederatedIdentityProviderName:
        params.samlCognitoFederatedIdentityProviderName,
      // Backend
      apiEndpointUrl: api.api.url,
      predictStreamFunctionArn: api.predictStreamFunction.functionArn,
      ragEnabled: params.ragEnabled,
      ragKnowledgeBaseEnabled: params.ragKnowledgeBaseEnabled,
      agentEnabled: params.agentEnabled || params.agents.length > 0,
      flows: params.flows,
      flowStreamFunctionArn: api.invokeFlowFunction.functionArn,
      optimizePromptFunctionArn: api.optimizePromptFunction.functionArn,
      webAclId: props.webAclId,
      modelRegion: api.modelRegion,
      modelIds: api.modelIds,
      imageGenerationModelIds: api.imageGenerationModelIds,
      videoGenerationModelIds: api.videoGenerationModelIds,
      endpointNames: api.endpointNames,
      agentNames: api.agentNames,
      inlineAgents: params.inlineAgents,
      useCaseBuilderEnabled: params.useCaseBuilderEnabled,
      speechToSpeechNamespace: speechToSpeech.namespace,
      speechToSpeechEventApiEndpoint: speechToSpeech.eventApiEndpoint,
      speechToSpeechModelIds: params.speechToSpeechModelIds,
      mcpEnabled: params.mcpEnabled,
      mcpEndpoint,
      agentCoreEnabled:
        params.createGenericAgentCoreRuntime ||
        params.agentCoreExternalRuntimes.length > 0,
      agentCoreGenericRuntime: genericRuntimeArn
        ? {
            name: genericRuntimeName || 'GenericAgentCoreRuntime',
            arn: genericRuntimeArn,
          }
        : undefined,
      agentCoreExternalRuntimes: params.agentCoreExternalRuntimes,
      agentCoreRegion: params.agentCoreRegion,
      // Frontend
      hiddenUseCases: params.hiddenUseCases,
      // Custom Domain
      cert: props.cert,
      hostName: params.hostName,
      domainName: params.domainName,
      hostedZoneId: params.hostedZoneId,
      // Closed network
      webBucket: props.webBucket,
      cognitoUserPoolProxyEndpoint: props.cognitoUserPoolProxyEndpoint,
      cognitoIdentityPoolProxyEndpoint: props.cognitoIdentityPoolProxyEndpoint,
    });

    // RAG
    if (params.ragEnabled) {
      const rag = new Rag(this, 'Rag', {
        envSuffix: params.env,
        kendraIndexLanguage: params.kendraIndexLanguage,
        kendraIndexArnInCdkContext: params.kendraIndexArn,
        kendraDataSourceBucketName: params.kendraDataSourceBucketName,
        kendraIndexScheduleEnabled: params.kendraIndexScheduleEnabled,
        kendraIndexScheduleCreateCron: params.kendraIndexScheduleCreateCron,
        kendraIndexScheduleDeleteCron: params.kendraIndexScheduleDeleteCron,
        userPool: auth.userPool,
        api: api.api,
        vpc: props.vpc,
        securityGroups,
      });

      // Allow downloading files from the File API to the data source Bucket
      // If you are importing existing Kendra, there is a possibility that the data source is not S3
      // In that case, rag.dataSourceBucketName will be undefined and the permission will not be granted
      if (
        rag.dataSourceBucketName &&
        api.getFileDownloadSignedUrlFunction.role
      ) {
        allowS3AccessWithSourceIpCondition(
          rag.dataSourceBucketName,
          api.getFileDownloadSignedUrlFunction.role,
          'read',
          {
            ipv4: params.allowedIpV4AddressRanges,
            ipv6: params.allowedIpV6AddressRanges,
          }
        );
      }
    }

    // RAG Knowledge Base
    if (params.ragKnowledgeBaseEnabled) {
      const knowledgeBaseId =
        params.ragKnowledgeBaseId || props.knowledgeBaseId;
      if (knowledgeBaseId) {
        new RagKnowledgeBase(this, 'RagKnowledgeBase', {
          modelRegion: params.modelRegion,
          crossAccountBedrockRoleArn: params.crossAccountBedrockRoleArn,
          knowledgeBaseId: knowledgeBaseId,
          userPool: auth.userPool,
          api: api.api,
          vpc: props.vpc,
          securityGroups,
        });
        // Allow downloading files from the File API to the data source Bucket
        if (
          props.knowledgeBaseDataSourceBucketName &&
          api.getFileDownloadSignedUrlFunction.role
        ) {
          allowS3AccessWithSourceIpCondition(
            props.knowledgeBaseDataSourceBucketName,
            api.getFileDownloadSignedUrlFunction.role,
            'read',
            {
              ipv4: params.allowedIpV4AddressRanges,
              ipv6: params.allowedIpV6AddressRanges,
            }
          );
        }
      }
    }

    // Usecase builder
    if (params.useCaseBuilderEnabled) {
      new UseCaseBuilder(this, 'UseCaseBuilder', {
        userPool: auth.userPool,
        api: api.api,
        vpc: props.vpc,
        securityGroups,
      });
    }

    // Transcribe
    new Transcribe(this, 'Transcribe', {
      userPool: auth.userPool,
      idPool: auth.idPool,
      api: api.api,
      allowedIpV4AddressRanges: params.allowedIpV4AddressRanges,
      allowedIpV6AddressRanges: params.allowedIpV6AddressRanges,
      vpc: props.vpc,
      securityGroups,
    });

    // Cfn Outputs
    new CfnOutput(this, 'Region', {
      value: this.region,
    });

    new CfnOutput(this, 'WebUrl', {
      value: web.webUrl,
    });

    new CfnOutput(this, 'ApiEndpoint', {
      value: api.api.url,
    });

    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });

    new CfnOutput(this, 'UserPoolClientId', {
      value: auth.client.userPoolClientId,
    });

    new CfnOutput(this, 'IdPoolId', { value: auth.idPool.identityPoolId });

    new CfnOutput(this, 'PredictStreamFunctionArn', {
      value: api.predictStreamFunction.functionArn,
    });

    new CfnOutput(this, 'OptimizePromptFunctionArn', {
      value: api.optimizePromptFunction.functionArn,
    });

    new CfnOutput(this, 'InvokeFlowFunctionArn', {
      value: api.invokeFlowFunction.functionArn,
    });

    new CfnOutput(this, 'Flows', {
      value: Buffer.from(JSON.stringify(params.flows)).toString('base64'),
    });

    new CfnOutput(this, 'RagEnabled', {
      value: params.ragEnabled.toString(),
    });

    new CfnOutput(this, 'RagKnowledgeBaseEnabled', {
      value: params.ragKnowledgeBaseEnabled.toString(),
    });

    new CfnOutput(this, 'AgentEnabled', {
      value: (params.agentEnabled || params.agents.length > 0).toString(),
    });

    new CfnOutput(this, 'SelfSignUpEnabled', {
      value: params.selfSignUpEnabled.toString(),
    });

    new CfnOutput(this, 'ModelRegion', {
      value: api.modelRegion,
    });

    new CfnOutput(this, 'ModelIds', {
      value: JSON.stringify(api.modelIds),
    });

    new CfnOutput(this, 'ImageGenerateModelIds', {
      value: JSON.stringify(api.imageGenerationModelIds),
    });

    new CfnOutput(this, 'VideoGenerateModelIds', {
      value: JSON.stringify(api.videoGenerationModelIds),
    });

    new CfnOutput(this, 'EndpointNames', {
      value: JSON.stringify(api.endpointNames),
    });

    new CfnOutput(this, 'SamlAuthEnabled', {
      value: params.samlAuthEnabled.toString(),
    });

    new CfnOutput(this, 'SamlCognitoDomainName', {
      value: params.samlCognitoDomainName ?? '',
    });

    new CfnOutput(this, 'SamlCognitoFederatedIdentityProviderName', {
      value: params.samlCognitoFederatedIdentityProviderName ?? '',
    });

    new CfnOutput(this, 'AgentNames', {
      value: Buffer.from(JSON.stringify(api.agentNames)).toString('base64'),
    });

    new CfnOutput(this, 'InlineAgents', {
      value: params.inlineAgents.toString(),
    });

    new CfnOutput(this, 'UseCaseBuilderEnabled', {
      value: params.useCaseBuilderEnabled.toString(),
    });

    new CfnOutput(this, 'HiddenUseCases', {
      value: JSON.stringify(params.hiddenUseCases),
    });

    new CfnOutput(this, 'SpeechToSpeechNamespace', {
      value: speechToSpeech.namespace,
    });

    new CfnOutput(this, 'SpeechToSpeechEventApiEndpoint', {
      value: speechToSpeech.eventApiEndpoint,
    });

    new CfnOutput(this, 'SpeechToSpeechModelIds', {
      value: JSON.stringify(params.speechToSpeechModelIds),
    });

    new CfnOutput(this, 'McpEnabled', {
      value: params.mcpEnabled.toString(),
    });

    new CfnOutput(this, 'McpEndpoint', {
      value: mcpEndpoint ?? '',
    });

    new CfnOutput(this, 'AgentCoreEnabled', {
      value: (
        params.createGenericAgentCoreRuntime ||
        params.agentCoreExternalRuntimes.length > 0
      ).toString(),
    });

    new CfnOutput(this, 'AgentCoreGenericRuntime', {
      value: genericRuntimeArn
        ? JSON.stringify({
            name: genericRuntimeName || 'GenericAgentCoreRuntime',
            arn: genericRuntimeArn,
          })
        : 'null',
    });

    new CfnOutput(this, 'AgentCoreExternalRuntimes', {
      value: JSON.stringify(params.agentCoreExternalRuntimes),
    });

    this.userPool = auth.userPool;
    this.userPoolClient = auth.client;

    this.exportValue(this.userPool.userPoolId);
    this.exportValue(this.userPoolClient.userPoolClientId);
  }
}
