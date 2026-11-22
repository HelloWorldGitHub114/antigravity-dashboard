export type LeafKind = 'scalar' | 'nonempty' | 'presence' | 'calls' | 'guid' | 'textEstimate';
export type ProjectionNode = LeafKind | { [key: string]: ProjectionNode };

export const scalar: LeafKind = 'scalar';
export const nonempty: LeafKind = 'nonempty';
export const presence: LeafKind = 'presence';
export const calls: LeafKind = 'calls';
export const guid: LeafKind = 'guid';

const usage: Record<string, LeafKind> = Object.fromEntries(
  [
    'inputTokens',
    'outputTokens',
    'responseOutputTokens',
    'thinkingOutputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'apiProvider',
    'responseId',
    'messageId',
    'model',
  ].map((k) => [k, scalar]),
);
const duration: Record<string, LeafKind> = { seconds: scalar, nanos: scalar };
const baseGeneratorItem: Record<string, ProjectionNode> = {
  stepIndices: { '*': scalar },
  chatModel: {
    usage,
    model: scalar,
    modelDisplayName: scalar,
    responseModel: scalar,
    error: scalar,
    streamingDuration: duration,
    timeToFirstToken: duration,
    retryInfos: { '*': { usage, error: scalar } },
    chatStartMetadata: {
      createdAt: scalar,
      contextWindowMetadata: { estimatedTokensUsed: scalar, maxContextTokens: scalar },
    },
  },
};
const baseGenerators: Record<string, ProjectionNode> = { '*': baseGeneratorItem };
const timelineGenerators: Record<string, ProjectionNode> = {
  '*': { ...baseGeneratorItem, plannerConfig: { planModel: scalar, plannerModel: scalar } },
};
const invokeSubagentSpec: Record<string, ProjectionNode> = { conversationId: guid, role: scalar, typeName: scalar };
const invokeSubagent: Record<string, ProjectionNode> = {
  conversationId: guid,
  subagents: { '*': invokeSubagentSpec },
  results: { '*': { conversationId: guid } },
};
export const userInputMeta: Record<string, ProjectionNode> = { userConfig: { plannerConfig: { planModel: scalar } } };
const baseSteps: Record<string, ProjectionNode> = {
  '*': {
    type: scalar,
    metadata: { createdAt: scalar, startedAt: scalar, completedAt: scalar, toolCall: presence },
    plannerResponse: { response: nonempty, toolCalls: calls },
    invokeSubagent,
    userInput: userInputMeta,
  },
};
const systemMessageMeta: Record<string, ProjectionNode> = { eventType: scalar };
const taskBoundaryMeta: Record<string, ProjectionNode> = { mode: scalar, Mode: scalar };
const timelineToolCalls: Record<string, ProjectionNode> = { '*': { name: scalar, status: scalar } };
const timelineSteps: Record<string, ProjectionNode> = {
  '*': {
    i: scalar,
    type: scalar,
    status: scalar,
    metadata: {
      createdAt: scalar,
      startedAt: scalar,
      viewableAt: scalar,
      finishedGeneratingAt: scalar,
      completedAt: scalar,
      toolCall: { name: scalar },
      generatorModel: scalar,
    },
    plannerResponse: { response: nonempty, toolCalls: timelineToolCalls },
    invokeSubagent,
    userInput: userInputMeta,
    systemMessage: systemMessageMeta,
    taskBoundary: taskBoundaryMeta,
    exitPlanMode: presence,
    enterPlanMode: presence,
  },
};
const subagentSpec: Record<string, ProjectionNode> = { role: scalar, typeName: scalar, inherit: scalar, modelTier: scalar };
const summaryMeta: Record<string, ProjectionNode> = {
  parentConversationId: guid,
  rootConversationId: guid,
  nestingDepth: scalar,
  subagentSpec,
};
const summaryEntry: Record<string, ProjectionNode> = {
  summary: scalar,
  stepCount: scalar,
  lastModifiedTime: scalar,
  status: scalar,
  lastUserInputStepIndex: scalar,
  hasActiveChildren: scalar,
  hasRunningSubagents: scalar,
  notFullyIdle: scalar,
  trajectoryMetadata: summaryMeta,
};
export const trajectorySummaries: Record<string, ProjectionNode> = { '*': summaryEntry };
export const trajectoryBase: Record<string, ProjectionNode> = {
  cascadeId: scalar,
  trajectoryId: scalar,
  planModel: scalar,
  steps: baseSteps,
  generatorMetadata: baseGenerators,
};
export const trajectoryTimeline: Record<string, ProjectionNode> = {
  cascadeId: scalar,
  trajectoryId: scalar,
  planModel: scalar,
  steps: timelineSteps,
  generatorMetadata: timelineGenerators,
};
const remoteModelInfo: Record<string, ProjectionNode> = {
  modelName: scalar,
  displayName: scalar,
  maxTokens: scalar,
  contextWindow: scalar,
  maxInputTokens: scalar,
};
const remoteRequestedModel: Record<string, ProjectionNode> = { model: scalar };
const remoteStepSourceInfo: Record<string, ProjectionNode> = { stepIndex: scalar };
const remotePlannerConfig: Record<string, ProjectionNode> = { planModel: scalar, plannerModel: scalar, modelName: scalar };
const remoteGenerators: Record<string, ProjectionNode> = {
  '*': { ...baseGeneratorItem, i: scalar, plannerConfig: remotePlannerConfig },
};
const remoteBaseMetadata: Record<string, ProjectionNode> = {
  createdAt: scalar,
  startedAt: scalar,
  completedAt: scalar,
  viewableAt: scalar,
  finishedGeneratingAt: scalar,
  toolCall: presence,
  toolCallOutputTokens: scalar,
  generatorModel: scalar,
  modelApiContentId: scalar,
  modelUsage: usage,
  modelInfo: remoteModelInfo,
  requestedModel: remoteRequestedModel,
  sourceTrajectoryStepInfo: remoteStepSourceInfo,
};
const remoteTimelineMetadata: Record<string, ProjectionNode> = { ...remoteBaseMetadata, toolCall: { name: scalar } };
const remoteBaseStepItem: Record<string, ProjectionNode> = {
  i: scalar,
  type: scalar,
  metadata: remoteBaseMetadata,
  plannerResponse: { response: nonempty, toolCalls: calls },
  invokeSubagent,
  userInput: userInputMeta,
};
const remoteBaseSteps: Record<string, ProjectionNode> = { '*': remoteBaseStepItem };
const remoteTimelineSteps: Record<string, ProjectionNode> = {
  '*': {
    ...remoteBaseStepItem,
    status: scalar,
    metadata: remoteTimelineMetadata,
    plannerResponse: { response: nonempty, toolCalls: timelineToolCalls },
    systemMessage: systemMessageMeta,
    taskBoundary: taskBoundaryMeta,
    exitPlanMode: presence,
    enterPlanMode: presence,
  },
};
const contextWindowUsage: Record<string, ProjectionNode> = { estimatedTokensUsed: scalar, maxContextTokens: scalar };
export const updateBase: Record<string, ProjectionNode> = {
  conversationId: scalar,
  status: scalar,
  planModel: scalar,
  contextWindowUsage,
  mainTrajectoryUpdate: { stepsUpdate: { steps: remoteBaseSteps }, generatorMetadatasUpdate: { generatorMetadatas: remoteGenerators } },
  trajectory: trajectoryBase,
  steps: baseSteps,
  generatorMetadata: baseGenerators,
  generatorMetadatas: baseGenerators,
  numTotalSteps: scalar,
  numTotalGeneratorMetadata: scalar,
};
export const updateTimeline: Record<string, ProjectionNode> = {
  conversationId: scalar,
  status: scalar,
  planModel: scalar,
  contextWindowUsage,
  mainTrajectoryUpdate: { stepsUpdate: { steps: remoteTimelineSteps }, generatorMetadatasUpdate: { generatorMetadatas: remoteGenerators } },
  trajectory: trajectoryTimeline,
  steps: timelineSteps,
  generatorMetadata: timelineGenerators,
  generatorMetadatas: timelineGenerators,
  numTotalSteps: scalar,
  numTotalGeneratorMetadata: scalar,
};
export const schema: Record<string, ProjectionNode> = {
  trajectory: trajectoryBase,
  steps: baseSteps,
  generatorMetadata: baseGenerators,
  generatorMetadatas: baseGenerators,
  planModel: scalar,
  status: scalar,
  numTotalSteps: scalar,
  numTotalGeneratorMetadata: scalar,
  trajectorySummaries,
  update: updateBase,
};
export const timelineSchema: Record<string, ProjectionNode> = {
  trajectory: trajectoryTimeline,
  steps: timelineSteps,
  generatorMetadata: timelineGenerators,
  generatorMetadatas: timelineGenerators,
  planModel: scalar,
  status: scalar,
  numTotalSteps: scalar,
  numTotalGeneratorMetadata: scalar,
  trajectorySummaries,
  update: updateTimeline,
};
export const dropEmptyNodes = new Set<ProjectionNode>([
  subagentSpec,
  invokeSubagentSpec,
  userInputMeta,
  systemMessageMeta,
  taskBoundaryMeta,
  remoteModelInfo,
  remoteRequestedModel,
  remoteStepSourceInfo,
  remotePlannerConfig,
]);
export const durationNode = duration;
