use std::fmt;

use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

const DEFAULT_MAX_RETAINED_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCALAR_STR_UTF16: usize = 16_384;
const MAX_KEY_BYTES: usize = 1024;
const MAX_DEPTH: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Node {
    Ignore,
    Scalar,
    NonEmpty,
    Presence,
    Calls,
    Guid,
    Duration,
    Usage,
    RetryInfo,
    RetryInfoArray,
    ScalarArray,
    ContextWindow,
    ChatStartMeta,
    ChatModel,
    PlannerConfigBase,
    PlannerConfigRemote,
    GeneratorBase,
    GeneratorTimeline,
    GeneratorRemote,
    GeneratorsBase,
    GeneratorsTimeline,
    GeneratorsRemote,
    InvokeSubagentSpec,
    InvokeSubagentSpecArray,
    InvokeSubagentResultArray,
    InvokeSubagent,
    UserInputMeta,
    UserInputConfig,
    UserInputPlannerConfig,
    SystemMessageMeta,
    TaskBoundaryMeta,
    TimelineToolCall,
    TimelineToolCalls,
    MetadataToolCallName,
    RemoteModelInfo,
    RemoteRequestedModel,
    RemoteStepSourceInfo,
    StepMetaBase,
    StepMetaTimeline,
    StepMetaRemoteBase,
    StepMetaRemoteTimeline,
    PlannerResponseBase,
    PlannerResponseTimeline,
    StepBase,
    StepTimeline,
    StepRemoteBase,
    StepRemoteTimeline,
    StepsBase,
    StepsTimeline,
    StepsRemoteBase,
    StepsRemoteTimeline,
    SubagentSpec,
    SummaryMeta,
    SummaryEntry,
    TrajectorySummaries,
    TrajectoryBase,
    TrajectoryTimeline,
    StepsUpdateBase,
    StepsUpdateTimeline,
    GenMetasUpdate,
    MainTrajectoryUpdateBase,
    MainTrajectoryUpdateTimeline,
    UpdateBase,
    UpdateTimeline,
    RootBase,
    RootTimeline,
}

impl Node {
    fn is_object_container(self) -> bool {
        !matches!(
            self,
            Node::Ignore
                | Node::Scalar
                | Node::NonEmpty
                | Node::Presence
                | Node::Calls
                | Node::Guid
                | Node::RetryInfoArray
                | Node::ScalarArray
                | Node::InvokeSubagentSpecArray
                | Node::InvokeSubagentResultArray
                | Node::TimelineToolCalls
                | Node::StepsBase
                | Node::StepsTimeline
                | Node::StepsRemoteBase
                | Node::StepsRemoteTimeline
                | Node::GeneratorsBase
                | Node::GeneratorsTimeline
                | Node::GeneratorsRemote
        )
    }

    fn is_array_container(self) -> bool {
        matches!(
            self,
            Node::Calls
                | Node::RetryInfoArray
                | Node::ScalarArray
                | Node::InvokeSubagentSpecArray
                | Node::InvokeSubagentResultArray
                | Node::TimelineToolCalls
                | Node::StepsBase
                | Node::StepsTimeline
                | Node::StepsRemoteBase
                | Node::StepsRemoteTimeline
                | Node::GeneratorsBase
                | Node::GeneratorsTimeline
                | Node::GeneratorsRemote
        )
    }

    fn is_steps_array(self) -> bool {
        matches!(
            self,
            Node::StepsBase
                | Node::StepsTimeline
                | Node::StepsRemoteBase
                | Node::StepsRemoteTimeline
        )
    }

    fn drop_if_empty(self) -> bool {
        matches!(
            self,
            Node::SubagentSpec
                | Node::InvokeSubagentSpec
                | Node::UserInputMeta
                | Node::SystemMessageMeta
                | Node::TaskBoundaryMeta
                | Node::RemoteModelInfo
                | Node::RemoteRequestedModel
                | Node::RemoteStepSourceInfo
                | Node::PlannerConfigRemote
        )
    }

    fn is_plan_model_host(self) -> bool {
        matches!(
            self,
            Node::TrajectoryBase
                | Node::TrajectoryTimeline
                | Node::UpdateBase
                | Node::UpdateTimeline
        )
    }

    fn elem_node(self) -> Node {
        match self {
            Node::RetryInfoArray => Node::RetryInfo,
            Node::ScalarArray => Node::Scalar,
            Node::InvokeSubagentSpecArray => Node::InvokeSubagentSpec,
            Node::InvokeSubagentResultArray => Node::InvokeSubagentResultArrayElem(),
            Node::TimelineToolCalls => Node::TimelineToolCall,
            Node::StepsBase => Node::StepBase,
            Node::StepsTimeline => Node::StepTimeline,
            Node::StepsRemoteBase => Node::StepRemoteBase,
            Node::StepsRemoteTimeline => Node::StepRemoteTimeline,
            Node::GeneratorsBase => Node::GeneratorBase,
            Node::GeneratorsTimeline => Node::GeneratorTimeline,
            Node::GeneratorsRemote => Node::GeneratorRemote,
            _ => Node::Ignore,
        }
    }

    #[allow(non_snake_case)]
    const fn InvokeSubagentResultArrayElem() -> Node {
        // { conversationId: guid }
        Node::InvokeSubagent
    }

    fn child(self, key: &str) -> Node {
        match self {
            Node::Duration => match key {
                "seconds" | "nanos" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::Usage => match key {
                "inputTokens"
                | "outputTokens"
                | "responseOutputTokens"
                | "thinkingOutputTokens"
                | "cacheReadTokens"
                | "cacheWriteTokens"
                | "apiProvider"
                | "responseId"
                | "messageId"
                | "model" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::RetryInfo => match key {
                "usage" => Node::Usage,
                _ => Node::Ignore,
            },
            Node::ContextWindow => match key {
                "estimatedTokensUsed" | "maxContextTokens" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::ChatStartMeta => match key {
                "createdAt" => Node::Scalar,
                "contextWindowMetadata" => Node::ContextWindow,
                _ => Node::Ignore,
            },
            Node::ChatModel => match key {
                "usage" => Node::Usage,
                "model" | "modelDisplayName" | "responseModel" => Node::Scalar,
                "streamingDuration" | "timeToFirstToken" => Node::Duration,
                "retryInfos" => Node::RetryInfoArray,
                "chatStartMetadata" => Node::ChatStartMeta,
                _ => Node::Ignore,
            },
            Node::PlannerConfigBase => match key {
                "planModel" | "plannerModel" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::PlannerConfigRemote => match key {
                "planModel" | "plannerModel" | "modelName" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::GeneratorBase => match key {
                "stepIndices" => Node::ScalarArray,
                "chatModel" => Node::ChatModel,
                _ => Node::Ignore,
            },
            Node::GeneratorTimeline => match key {
                "stepIndices" => Node::ScalarArray,
                "chatModel" => Node::ChatModel,
                "plannerConfig" => Node::PlannerConfigBase,
                _ => Node::Ignore,
            },
            Node::GeneratorRemote => match key {
                "stepIndices" => Node::ScalarArray,
                "chatModel" => Node::ChatModel,
                "i" => Node::Scalar,
                "plannerConfig" => Node::PlannerConfigRemote,
                _ => Node::Ignore,
            },
            Node::InvokeSubagentSpec => match key {
                "conversationId" => Node::Guid,
                "role" | "typeName" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::InvokeSubagent => match key {
                "conversationId" => Node::Guid,
                "subagents" => Node::InvokeSubagentSpecArray,
                "results" => Node::InvokeSubagentResultArray,
                _ => Node::Ignore,
            },
            Node::UserInputMeta => match key {
                "userConfig" => Node::UserInputConfig,
                _ => Node::Ignore,
            },
            Node::UserInputConfig => match key {
                "plannerConfig" => Node::UserInputPlannerConfig,
                _ => Node::Ignore,
            },
            Node::UserInputPlannerConfig => match key {
                "planModel" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::SystemMessageMeta => match key {
                "eventType" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::TaskBoundaryMeta => match key {
                "mode" | "Mode" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::TimelineToolCall => match key {
                "name" | "status" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::MetadataToolCallName => match key {
                "name" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::RemoteModelInfo => match key {
                "modelName" | "displayName" | "maxTokens" | "contextWindow" | "maxInputTokens" => {
                    Node::Scalar
                }
                _ => Node::Ignore,
            },
            Node::RemoteRequestedModel => match key {
                "model" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::RemoteStepSourceInfo => match key {
                "stepIndex" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::StepMetaBase => match key {
                "createdAt" | "startedAt" | "completedAt" => Node::Scalar,
                "toolCall" => Node::Presence,
                _ => Node::Ignore,
            },
            Node::StepMetaTimeline => match key {
                "createdAt" | "startedAt" | "completedAt" | "generatorModel" => Node::Scalar,
                "toolCall" => Node::MetadataToolCallName,
                _ => Node::Ignore,
            },
            Node::StepMetaRemoteBase => match key {
                "createdAt"
                | "startedAt"
                | "completedAt"
                | "viewableAt"
                | "finishedGeneratingAt"
                | "toolCallOutputTokens"
                | "generatorModel"
                | "modelApiContentId" => Node::Scalar,
                "toolCall" => Node::Presence,
                "modelUsage" => Node::Usage,
                "modelInfo" => Node::RemoteModelInfo,
                "requestedModel" => Node::RemoteRequestedModel,
                "sourceTrajectoryStepInfo" => Node::RemoteStepSourceInfo,
                _ => Node::Ignore,
            },
            Node::StepMetaRemoteTimeline => match key {
                "createdAt"
                | "startedAt"
                | "completedAt"
                | "viewableAt"
                | "finishedGeneratingAt"
                | "toolCallOutputTokens"
                | "generatorModel"
                | "modelApiContentId" => Node::Scalar,
                "toolCall" => Node::MetadataToolCallName,
                "modelUsage" => Node::Usage,
                "modelInfo" => Node::RemoteModelInfo,
                "requestedModel" => Node::RemoteRequestedModel,
                "sourceTrajectoryStepInfo" => Node::RemoteStepSourceInfo,
                _ => Node::Ignore,
            },
            Node::PlannerResponseBase => match key {
                "response" => Node::NonEmpty,
                "toolCalls" => Node::Calls,
                _ => Node::Ignore,
            },
            Node::PlannerResponseTimeline => match key {
                "response" => Node::NonEmpty,
                "toolCalls" => Node::TimelineToolCalls,
                _ => Node::Ignore,
            },
            Node::StepBase => match key {
                "type" => Node::Scalar,
                "metadata" => Node::StepMetaBase,
                "plannerResponse" => Node::PlannerResponseBase,
                "invokeSubagent" => Node::InvokeSubagent,
                "userInput" => Node::UserInputMeta,
                _ => Node::Ignore,
            },
            Node::StepTimeline => match key {
                "i" | "type" | "status" => Node::Scalar,
                "metadata" => Node::StepMetaTimeline,
                "plannerResponse" => Node::PlannerResponseTimeline,
                "invokeSubagent" => Node::InvokeSubagent,
                "userInput" => Node::UserInputMeta,
                "systemMessage" => Node::SystemMessageMeta,
                "taskBoundary" => Node::TaskBoundaryMeta,
                "exitPlanMode" | "enterPlanMode" => Node::Presence,
                _ => Node::Ignore,
            },
            Node::StepRemoteBase => match key {
                "i" | "type" => Node::Scalar,
                "metadata" => Node::StepMetaRemoteBase,
                "plannerResponse" => Node::PlannerResponseBase,
                "invokeSubagent" => Node::InvokeSubagent,
                "userInput" => Node::UserInputMeta,
                _ => Node::Ignore,
            },
            Node::StepRemoteTimeline => match key {
                "i" | "type" | "status" => Node::Scalar,
                "metadata" => Node::StepMetaRemoteTimeline,
                "plannerResponse" => Node::PlannerResponseTimeline,
                "invokeSubagent" => Node::InvokeSubagent,
                "userInput" => Node::UserInputMeta,
                "systemMessage" => Node::SystemMessageMeta,
                "taskBoundary" => Node::TaskBoundaryMeta,
                "exitPlanMode" | "enterPlanMode" => Node::Presence,
                _ => Node::Ignore,
            },
            Node::SubagentSpec => match key {
                "role" | "typeName" | "inherit" | "modelTier" => Node::Scalar,
                _ => Node::Ignore,
            },
            Node::SummaryMeta => match key {
                "parentConversationId" | "rootConversationId" => Node::Guid,
                "nestingDepth" => Node::Scalar,
                "subagentSpec" => Node::SubagentSpec,
                _ => Node::Ignore,
            },
            Node::SummaryEntry => match key {
                "summary"
                | "stepCount"
                | "lastModifiedTime"
                | "status"
                | "lastUserInputStepIndex"
                | "hasActiveChildren"
                | "hasRunningSubagents"
                | "notFullyIdle" => Node::Scalar,
                "trajectoryMetadata" => Node::SummaryMeta,
                _ => Node::Ignore,
            },
            Node::TrajectorySummaries => Node::SummaryEntry,
            Node::TrajectoryBase => match key {
                "cascadeId" | "trajectoryId" | "planModel" => Node::Scalar,
                "steps" => Node::StepsBase,
                "generatorMetadata" => Node::GeneratorsBase,
                _ => Node::Ignore,
            },
            Node::TrajectoryTimeline => match key {
                "cascadeId" | "trajectoryId" | "planModel" => Node::Scalar,
                "steps" => Node::StepsTimeline,
                "generatorMetadata" => Node::GeneratorsTimeline,
                _ => Node::Ignore,
            },
            Node::StepsUpdateBase => match key {
                "steps" => Node::StepsRemoteBase,
                _ => Node::Ignore,
            },
            Node::StepsUpdateTimeline => match key {
                "steps" => Node::StepsRemoteTimeline,
                _ => Node::Ignore,
            },
            Node::GenMetasUpdate => match key {
                "generatorMetadatas" => Node::GeneratorsRemote,
                _ => Node::Ignore,
            },
            Node::MainTrajectoryUpdateBase => match key {
                "stepsUpdate" => Node::StepsUpdateBase,
                "generatorMetadatasUpdate" => Node::GenMetasUpdate,
                _ => Node::Ignore,
            },
            Node::MainTrajectoryUpdateTimeline => match key {
                "stepsUpdate" => Node::StepsUpdateTimeline,
                "generatorMetadatasUpdate" => Node::GenMetasUpdate,
                _ => Node::Ignore,
            },
            Node::UpdateBase => match key {
                "conversationId"
                | "status"
                | "planModel"
                | "numTotalSteps"
                | "numTotalGeneratorMetadata" => Node::Scalar,
                "contextWindowUsage" => Node::ContextWindow,
                "mainTrajectoryUpdate" => Node::MainTrajectoryUpdateBase,
                "trajectory" => Node::TrajectoryBase,
                "steps" => Node::StepsBase,
                "generatorMetadata" | "generatorMetadatas" => Node::GeneratorsBase,
                _ => Node::Ignore,
            },
            Node::UpdateTimeline => match key {
                "conversationId"
                | "status"
                | "planModel"
                | "numTotalSteps"
                | "numTotalGeneratorMetadata" => Node::Scalar,
                "contextWindowUsage" => Node::ContextWindow,
                "mainTrajectoryUpdate" => Node::MainTrajectoryUpdateTimeline,
                "trajectory" => Node::TrajectoryTimeline,
                "steps" => Node::StepsTimeline,
                "generatorMetadata" | "generatorMetadatas" => Node::GeneratorsTimeline,
                _ => Node::Ignore,
            },
            Node::RootBase => match key {
                "trajectory" => Node::TrajectoryBase,
                "steps" => Node::StepsBase,
                "generatorMetadata" | "generatorMetadatas" => Node::GeneratorsBase,
                "planModel"
                | "status"
                | "numTotalSteps"
                | "numTotalGeneratorMetadata" => Node::Scalar,
                "trajectorySummaries" => Node::TrajectorySummaries,
                "update" => Node::UpdateBase,
                _ => Node::Ignore,
            },
            Node::RootTimeline => match key {
                "trajectory" => Node::TrajectoryTimeline,
                "steps" => Node::StepsTimeline,
                "generatorMetadata" | "generatorMetadatas" => Node::GeneratorsTimeline,
                "planModel"
                | "status"
                | "numTotalSteps"
                | "numTotalGeneratorMetadata" => Node::Scalar,
                "trajectorySummaries" => Node::TrajectorySummaries,
                "update" => Node::UpdateTimeline,
                _ => Node::Ignore,
            },
            _ => Node::Ignore,
        }
    }
}

struct ProjectState {
    max_retained_bytes: usize,
    max_steps: Option<usize>,
    model_timeline_enabled: bool,
    retained: usize,
    captured_plan_model: Option<String>,
}

impl ProjectState {
    fn new(max_retained_bytes: usize, max_steps: Option<usize>, model_timeline_enabled: bool) -> Self {
        Self {
            max_retained_bytes,
            max_steps,
            model_timeline_enabled,
            retained: 0,
            captured_plan_model: None,
        }
    }

    fn charge(&mut self, bytes: usize) -> Result<(), String> {
        self.retained = self.retained.saturating_add(bytes);
        if self.retained > self.max_retained_bytes {
            return Err("会话统计数据超过采集上限".to_string());
        }
        Ok(())
    }
}

pub(crate) fn normalize_conversation_id(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    for (i, &b) in bytes.iter().enumerate() {
        if matches!(i, 8 | 13 | 18 | 23) {
            if b != b'-' {
                return None;
            }
        } else if !b.is_ascii_hexdigit() {
            return None;
        }
    }
    Some(s.to_ascii_lowercase())
}

fn is_truthy_json(val: &Value) -> bool {
    match val {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

struct NodeSeed<'a> {
    node: Node,
    depth: usize,
    state: &'a mut ProjectState,
}

impl<'de, 'a> DeserializeSeed<'de> for NodeSeed<'a> {
    type Value = Option<Value>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(NodeVisitor {
            node: self.node,
            depth: self.depth,
            state: self.state,
        })
    }
}

struct NodeVisitor<'a> {
    node: Node,
    depth: usize,
    state: &'a mut ProjectState,
}

impl<'a> NodeVisitor<'a> {
    fn map_err<E: de::Error>(&self, msg: String) -> E {
        de::Error::custom(msg)
    }

    fn handle_str<E: de::Error>(&mut self, s: &str) -> Result<Option<Value>, E> {
        match self.node {
            Node::Ignore => Ok(None),
            Node::Guid => Ok(normalize_conversation_id(s).map(Value::String)),
            Node::NonEmpty => {
                let any = s.chars().any(|c| !c.is_whitespace());
                Ok(Some(Value::String(if any { "1" } else { "" }.to_string())))
            }
            Node::Presence => Ok(Some(Value::Bool(!s.is_empty()))),
            Node::Scalar | Node::Duration => {
                let utf16_len: usize = s.chars().map(|c| c.len_utf16()).sum();
                if utf16_len > MAX_SCALAR_STR_UTF16 {
                    return Err(de::Error::custom("会话统计字段超过采集上限"));
                }
                self.state.charge(utf16_len * 2).map_err(|m| self.map_err(m))?;
                Ok(Some(Value::String(s.to_string())))
            }
            _ => Ok(None),
        }
    }
}

impl<'de, 'a> Visitor<'de> for NodeVisitor<'a> {
    type Value = Option<Value>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
        if matches!(self.node, Node::Ignore | Node::Guid) {
            Ok(None)
        } else {
            Ok(Some(Value::Bool(v)))
        }
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
        if matches!(self.node, Node::Ignore | Node::Guid) {
            Ok(None)
        } else {
            Ok(Some(Value::Number(v.into())))
        }
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
        if matches!(self.node, Node::Ignore | Node::Guid) {
            Ok(None)
        } else {
            Ok(Some(Value::Number(v.into())))
        }
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        if matches!(self.node, Node::Ignore | Node::Guid) {
            Ok(None)
        } else {
            Ok(serde_json::Number::from_f64(v).map(Value::Number))
        }
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        if matches!(self.node, Node::Ignore | Node::Guid) {
            Ok(None)
        } else {
            Ok(Some(Value::Null))
        }
    }

    fn visit_str<E: de::Error>(mut self, v: &str) -> Result<Self::Value, E> {
        self.handle_str(v)
    }

    fn visit_string<E: de::Error>(mut self, v: String) -> Result<Self::Value, E> {
        self.handle_str(&v)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        if self.depth >= MAX_DEPTH {
            return Err(de::Error::custom("Antigravity 接口返回了过深的嵌套数据"));
        }
        if self.node == Node::Calls {
            let mut count = 0usize;
            while seq.next_element::<IgnoredAny>()?.is_some() {
                count += 1;
            }
            return Ok(Some(Value::Array(if count > 0 {
                vec![Value::Object(Map::new())]
            } else {
                Vec::new()
            })));
        }
        if self.node == Node::Presence {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            return Ok(Some(Value::Bool(true)));
        }
        if !self.node.is_array_container() {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            return Ok(None);
        }

        self.state.charge(64).map_err(|m| de::Error::custom(m))?;
        let elem_node = self.node.elem_node();
        let is_steps = self.node.is_steps_array();
        let max_steps = self.state.max_steps;
        let mut out = Vec::new();
        let mut idx = 0usize;

        loop {
            if is_steps && max_steps.is_some_and(|cap| idx >= cap) {
                if seq.next_element::<IgnoredAny>()?.is_none() {
                    break;
                }
                idx += 1;
                continue;
            }
            let Some(val) = seq.next_element_seed(NodeSeed {
                node: elem_node,
                depth: self.depth + 1,
                state: self.state,
            })? else {
                break;
            };
            idx += 1;
            if let Some(v) = val {
                self.state.charge(32).map_err(|m| de::Error::custom(m))?;
                out.push(v);
            }
        }
        Ok(Some(Value::Array(out)))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        if self.depth >= MAX_DEPTH {
            return Err(de::Error::custom("Antigravity 接口返回了过深的嵌套数据"));
        }
        if self.node == Node::Presence {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            return Ok(Some(Value::Bool(true)));
        }
        if !self.node.is_object_container() {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            return Ok(None);
        }

        self.state.charge(64).map_err(|m| de::Error::custom(m))?;
        let mut out = Map::new();
        let is_summaries = self.node == Node::TrajectorySummaries;

        while let Some(raw_key) = map.next_key::<String>()? {
            let key_opt = if is_summaries {
                normalize_conversation_id(&raw_key)
            } else if raw_key.len() > MAX_KEY_BYTES {
                None
            } else {
                Some(raw_key)
            };

            let child_node = match key_opt.as_deref() {
                Some(k) => self.node.child(k),
                None => Node::Ignore,
            };

            if child_node == Node::Ignore {
                let _ = map.next_value::<IgnoredAny>()?;
                continue;
            }

            let val_opt = map.next_value_seed(NodeSeed {
                node: child_node,
                depth: self.depth + 1,
                state: self.state,
            })?;

            if let (Some(k), Some(v)) = (key_opt, val_opt) {
                self.state.charge(32).map_err(|m| de::Error::custom(m))?;
                out.insert(k, v);
            }
        }

        if self.node == Node::UserInputMeta {
            let pm = out
                .get("userConfig")
                .and_then(|u| u.get("plannerConfig"))
                .and_then(|p| p.get("planModel"))
                .and_then(Value::as_str)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());
            if let Some(model) = pm {
                let truncated: String = model.chars().take(256).collect();
                self.state.captured_plan_model = Some(truncated);
                if !self.state.model_timeline_enabled {
                    return Ok(None);
                }
            } else {
                return Ok(None);
            }
        }

        if self.node.is_plan_model_host() {
            if let Some(ref pm) = self.state.captured_plan_model {
                let has_pm = out.get("planModel").is_some_and(is_truthy_json);
                if !has_pm {
                    out.insert("planModel".to_string(), Value::String(pm.clone()));
                }
            }
        }

        if self.node.drop_if_empty() && out.is_empty() {
            return Ok(None);
        }

        if matches!(self.node, Node::RootBase | Node::RootTimeline) {
            if let Some(ref pm) = self.state.captured_plan_model {
                let has_traj = out.contains_key("trajectory");
                let has_steps = out.contains_key("steps");
                let has_pm = out.get("planModel").is_some_and(is_truthy_json);
                if !has_traj && has_steps && !has_pm {
                    out.insert("planModel".to_string(), Value::String(pm.clone()));
                }
            }
        }

        Ok(Some(Value::Object(out)))
    }
}

struct ProjectOptions {
    max_steps: Option<usize>,
    max_retained_bytes: usize,
    model_timeline_enabled: bool,
}

impl Default for ProjectOptions {
    fn default() -> Self {
        Self {
            max_steps: None,
            max_retained_bytes: DEFAULT_MAX_RETAINED_BYTES,
            model_timeline_enabled: false,
        }
    }
}

fn project_raw_str(raw_json: &str, opts: &ProjectOptions) -> Result<Value, String> {
    let mut state = ProjectState::new(
        opts.max_retained_bytes,
        opts.max_steps,
        opts.model_timeline_enabled,
    );
    let root_node = if opts.model_timeline_enabled {
        Node::RootTimeline
    } else {
        Node::RootBase
    };
    let mut de = serde_json::Deserializer::from_str(raw_json);
    let projected = NodeSeed {
        node: root_node,
        depth: 0,
        state: &mut state,
    }
    .deserialize(&mut de)
    .map_err(|e| format!("Antigravity 接口返回了无法解析的数据: {e}"))?;
    de.end()
        .map_err(|e| format!("Antigravity 接口返回了无法解析的数据: {e}"))?;
    match projected {
        Some(val @ Value::Object(_)) => Ok(val),
        _ => Err("Antigravity 接口返回了无法解析的数据".to_string()),
    }
}

enum RawInput {
    None,
    Str(String),
    Projected(Value),
}

struct WrapperPayload {
    raw: RawInput,
    opts: ProjectOptions,
    saw_wrapper_key: bool,
    saw_non_wrapper_key: bool,
}

struct WrapperVisitor;

impl<'de> Visitor<'de> for WrapperVisitor {
    type Value = WrapperPayload;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut opts = ProjectOptions::default();
        let mut mode_str: Option<String> = None;
        let mut explicit_timeline: Option<bool> = None;
        let mut raw_str: Option<String> = None;
        let mut raw_obj: Option<Value> = None;
        let mut saw_raw_key = false;
        let mut saw_wrapper_key = false;
        let mut saw_non_wrapper_key = false;

        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "rawJson" => {
                    saw_raw_key = true;
                    saw_wrapper_key = true;
                    let val: Value = map.next_value()?;
                    match val {
                        Value::String(s) => raw_str = Some(s),
                        obj @ Value::Object(_) => raw_obj = Some(obj),
                        _ => return Err(de::Error::custom("rawJson must be a JSON string or object")),
                    }
                }
                "maxSteps" => {
                    saw_wrapper_key = true;
                    let v: Option<u64> = map.next_value()?;
                    opts.max_steps = v.map(|n| usize::try_from(n).unwrap_or(usize::MAX));
                }
                "maxRetainedBytes" => {
                    saw_wrapper_key = true;
                    let v: Option<u64> = map.next_value()?;
                    if let Some(n) = v {
                        opts.max_retained_bytes = usize::try_from(n).unwrap_or(usize::MAX);
                    }
                }
                "mode" => {
                    saw_wrapper_key = true;
                    mode_str = map.next_value()?;
                }
                "modelTimelineEnabled" => {
                    saw_wrapper_key = true;
                    explicit_timeline = map.next_value()?;
                }
                _ => {
                    saw_non_wrapper_key = true;
                    let _ = map.next_value::<IgnoredAny>()?;
                }
            }
        }

        opts.model_timeline_enabled = explicit_timeline
            .unwrap_or_else(|| mode_str.as_deref() == Some("timeline"));

        let raw = if let Some(s) = raw_str {
            RawInput::Str(s)
        } else if let Some(obj) = raw_obj {
            // Re-project inline object through the exact same schema rules.
            let serialized = serde_json::to_string(&obj).map_err(de::Error::custom)?;
            let projected = project_raw_str(&serialized, &opts).map_err(de::Error::custom)?;
            RawInput::Projected(projected)
        } else if saw_raw_key {
            return Err(de::Error::custom("missing rawJson"));
        } else {
            RawInput::None
        };

        Ok(WrapperPayload {
            raw,
            opts,
            saw_wrapper_key,
            saw_non_wrapper_key,
        })
    }
}

/// Projects minimal structural and statistical fields from a Trajectory / Update JSON payload,
/// discarding bulky tool outputs, prompts, markdown bodies, and thinking payloads.
///
/// Accepts `{ rawJson, maxSteps?, maxRetainedBytes?, mode?, modelTimelineEnabled? }`
/// or a direct raw trajectory/update JSON object.
pub fn project_trajectory_json(input_json: &str) -> Result<String, String> {
    let mut de = serde_json::Deserializer::from_str(input_json);
    let wrapper = de
        .deserialize_map(WrapperVisitor)
        .map_err(|e| format!("Antigravity 接口返回了无法解析的数据: {e}"))?;
    de.end()
        .map_err(|e| format!("Antigravity 接口返回了无法解析的数据: {e}"))?;

    let projected = match wrapper.raw {
        RawInput::Str(s) => project_raw_str(&s, &wrapper.opts)?,
        RawInput::Projected(val) => val,
        RawInput::None => {
            if wrapper.saw_wrapper_key && !wrapper.saw_non_wrapper_key {
                return Err("missing rawJson".to_string());
            }
            project_raw_str(input_json, &wrapper.opts)?
        }
    };

    serde_json::to_string(&projected).map_err(|e| format!("failed to serialize projection: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projects_base_and_timeline_schemas_and_captures_plan_model() {
        let fixture = json!({
            "trajectory": {
                "cascadeId": "11111111-1111-1111-1111-111111111111",
                "steps": [
                    {
                        "type": "CORTEX_STEP_TYPE_USER_INPUT",
                        "status": "CORTEX_STEP_STATUS_DONE",
                        "metadata": { "createdAt": "2026-11-14T06:38:52Z" },
                        "userInput": {
                            "text": "SECRET USER PROMPT",
                            "userConfig": { "plannerConfig": { "planModel": "MODEL_PLACEHOLDER_M668" } }
                        }
                    },
                    {
                        "type": "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
                        "status": "CORTEX_STEP_STATUS_DONE",
                        "metadata": {
                            "createdAt": "2026-11-14T06:39:00Z",
                            "generatorModel": "MODEL_PLACEHOLDER_M668"
                        },
                        "plannerResponse": {
                            "response": "SECRET REPLY",
                            "thought": "SECRET THINKING",
                            "toolCalls": [{
                                "name": "read_file",
                                "status": "DONE",
                                "argumentsJson": "{\"path\":\"C:/secret/key.txt\"}"
                            }]
                        }
                    },
                    {
                        "type": "CORTEX_STEP_TYPE_SYSTEM_MESSAGE",
                        "systemMessage": { "eventType": "plan_mode_handoff", "message": "SECRET" }
                    }
                ],
                "generatorMetadata": [{
                    "stepIndices": [1],
                    "chatModel": {
                        "messages": [{ "content": "SECRET CONTEXT" }],
                        "modelDisplayName": "Gemini",
                        "streamingDuration": "2s",
                        "usage": {
                            "inputTokens": 100,
                            "outputTokens": 200,
                            "responseId": "req-1"
                        }
                    }
                }]
            },
            "numTotalSteps": 3,
            "status": "CASCADE_RUN_STATUS_IDLE"
        });

        let raw_str = serde_json::to_string(&fixture).unwrap();
        let base_req = serde_json::to_string(&json!({ "rawJson": raw_str })).unwrap();
        let base_out_str = project_trajectory_json(&base_req).unwrap();
        assert!(!base_out_str.contains("SECRET"));
        assert!(!base_out_str.contains("key.txt"));

        let base_out: Value = serde_json::from_str(&base_out_str).unwrap();
        assert_eq!(base_out["trajectory"]["planModel"], "MODEL_PLACEHOLDER_M668");
        assert!(base_out["trajectory"]["steps"][0].get("userInput").is_none());
        assert!(base_out["trajectory"]["steps"][1].get("status").is_none());
        assert_eq!(
            base_out["trajectory"]["steps"][1]["plannerResponse"]["toolCalls"],
            json!([{}])
        );
        assert_eq!(
            base_out["trajectory"]["steps"][1]["plannerResponse"]["response"],
            "1"
        );
        assert!(base_out["trajectory"]["steps"][2].get("systemMessage").is_none());

        let tl_req = serde_json::to_string(&json!({
            "rawJson": raw_str,
            "mode": "timeline"
        }))
        .unwrap();
        let tl_out_str = project_trajectory_json(&tl_req).unwrap();
        assert!(!tl_out_str.contains("SECRET"));
        let tl_out: Value = serde_json::from_str(&tl_out_str).unwrap();
        assert_eq!(
            tl_out["trajectory"]["steps"][0]["userInput"]["userConfig"]["plannerConfig"]["planModel"],
            "MODEL_PLACEHOLDER_M668"
        );
        assert_eq!(
            tl_out["trajectory"]["steps"][1]["metadata"]["generatorModel"],
            "MODEL_PLACEHOLDER_M668"
        );
        assert_eq!(
            tl_out["trajectory"]["steps"][1]["plannerResponse"]["toolCalls"],
            json!([{ "name": "read_file", "status": "DONE" }])
        );
        assert_eq!(
            tl_out["trajectory"]["steps"][2]["systemMessage"],
            json!({ "eventType": "plan_mode_handoff" })
        );
    }

    #[test]
    fn projects_update_schema_direct_raw_and_enforces_limits() {
        let update = json!({
            "update": {
                "conversationId": "conv-1",
                "status": "CASCADE_RUN_STATUS_RUNNING",
                "contextWindowUsage": { "estimatedTokensUsed": 4200, "maxContextTokens": 1048576, "secret": "SECRET" },
                "mainTrajectoryUpdate": {
                    "stepsUpdate": {
                        "steps": [
                            { "i": 0, "type": "CORTEX_STEP_TYPE_USER_INPUT", "userInput": { "userConfig": { "plannerConfig": { "planModel": "MODEL_X" } } } },
                            { "i": 1, "type": "CORTEX_STEP_TYPE_PLANNER_RESPONSE", "plannerResponse": { "response": "ok" } }
                        ]
                    }
                }
            }
        });
        let direct = project_trajectory_json(&serde_json::to_string(&update).unwrap()).unwrap();
        let parsed: Value = serde_json::from_str(&direct).unwrap();
        assert!(!direct.contains("SECRET"));
        assert_eq!(parsed["update"]["planModel"], "MODEL_X");
        assert_eq!(parsed["update"]["status"], "CASCADE_RUN_STATUS_RUNNING");

        let capped = project_trajectory_json(
            &serde_json::to_string(&json!({
                "rawJson": serde_json::to_string(&update).unwrap(),
                "maxSteps": 1
            }))
            .unwrap(),
        )
        .unwrap();
        let capped_val: Value = serde_json::from_str(&capped).unwrap();
        assert_eq!(
            capped_val["update"]["mainTrajectoryUpdate"]["stepsUpdate"]["steps"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        assert!(project_trajectory_json("{\"ignored\":\"bad\\x\"}").is_err());
        assert!(project_trajectory_json("{\"trajectory\":{}}garbage").is_err());
        let budget_err = project_trajectory_json(
            &serde_json::to_string(&json!({
                "rawJson": "{\"trajectory\":{}}",
                "maxRetainedBytes": 1
            }))
            .unwrap(),
        );
        assert!(budget_err.is_err());
    }
}
