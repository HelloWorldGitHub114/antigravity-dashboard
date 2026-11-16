/// Maps `exa.codeium_common_pb.Model` enum integers to their canonical Protobuf enum names.
pub fn model_enum_to_str(val: i32) -> Option<String> {
    if val <= 0 {
        return None;
    }
    if val >= 1000 {
        return Some(format!("MODEL_PLACEHOLDER_M{}", val - 1000));
    }
    let known = match val {
        79 => "MODEL_CHAT_11121",
        85 => "MODEL_CHAT_12119",
        90 => "MODEL_CHAT_12121",
        105 => "MODEL_CHAT_19820",
        109 => "MODEL_GOOGLE_GEMINI_1_0_PRO",
        162 => "MODEL_GOOGLE_GEMINI_1_5_PRO",
        166 => "MODEL_CLAUDE_3_5_SONNET_20240620",
        181 => "MODEL_GOOGLE_GEMINI_1_5_FLASH",
        192 => "MODEL_GOOGLE_GEMINI_1_5_PRO_002",
        193 => "MODEL_GOOGLE_GEMINI_1_5_FLASH_002",
        201 => "MODEL_CLAUDE_3_5_SONNET_20241022",
        203 => "MODEL_CLAUDE_3_5_HAIKU_20241022",
        205 => "MODEL_GOOGLE_GEMINI_EXP_1114",
        207 => "MODEL_GOOGLE_GEMINI_EXP_1121",
        212 => "MODEL_CHAT_O1",
        220 => "MODEL_GOOGLE_GEMINI_EXP_1206",
        222 => "MODEL_GOOGLE_GEMINI_2_0_FLASH_EXP",
        226 => "MODEL_GOOGLE_GEMINI_2_0_FLASH_THINKING_EXP_1219",
        231 => "MODEL_CHAT_O3_MINI",
        232 => "MODEL_CHAT_O3_MINI_LOW",
        233 => "MODEL_CHAT_O3_MINI_HIGH",
        235 => "MODEL_GOOGLE_GEMINI_2_0_FLASH_THINKING_EXP_0121",
        240 => "MODEL_GOOGLE_GEMINI_2_0_PRO_EXP_0205",
        241 => "MODEL_GOOGLE_GEMINI_2_0_FLASH_001",
        242 => "MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE_PREVIEW_0205",
        243 => "MODEL_CLAUDE_3_7_SONNET_20250219",
        244 => "MODEL_CLAUDE_3_7_SONNET_20250219_THINKING",
        246 => "MODEL_GOOGLE_GEMINI_2_5_PRO",
        263 => "MODEL_CHAT_GPT_4_5",
        280 => "MODEL_GOOGLE_GEMINI_2_5_PRO_PREVIEW_0325",
        281 => "MODEL_CLAUDE_4_SONNET",
        282 => "MODEL_CLAUDE_4_SONNET_THINKING",
        283 => "MODEL_CHAT_GPT_4_1",
        284 => "MODEL_CHAT_GPT_4_1_MINI",
        285 => "MODEL_CHAT_GPT_4_1_NANO",
        286 => "MODEL_CHAT_O3",
        287 => "MODEL_CHAT_O4_MINI",
        290 => "MODEL_CLAUDE_4_OPUS",
        291 => "MODEL_CLAUDE_4_OPUS_THINKING",
        294 => "MODEL_CHAT_O3_LOW",
        295 => "MODEL_CHAT_O3_HIGH",
        296 => "MODEL_CHAT_O4_MINI_LOW",
        297 => "MODEL_CHAT_O4_MINI_HIGH",
        302 => "MODEL_GOOGLE_GEMINI_2_5_FLASH_PREVIEW_0417",
        303 => "MODEL_GOOGLE_GEMINI_2_5_FLASH_PREVIEW_0417_THINKING",
        309 => "MODEL_GOOGLE_GEMINI_2_5_PRO_PREVIEW_0506",
        311 => "MODEL_GOOGLE_GEMINI_2_5_FLASH_PREVIEW_0520",
        312 => "MODEL_GOOGLE_GEMINI_2_5_FLASH",
        313 => "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
        319 => "MODEL_GOOGLE_GEMINI_2_5_PRO_PREVIEW_0605",
        320 => "MODEL_CHAT_O3_PRO",
        326 => "MODEL_GOOGLE_GEMINI_INTERNAL_BYOM",
        327 => "MODEL_CLAUDE_4_1_OPUS",
        328 => "MODEL_CLAUDE_4_1_OPUS_THINKING",
        329 => "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING_TOOLS",
        330 => "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE",
        333 => "MODEL_CLAUDE_4_5_SONNET",
        334 => "MODEL_CLAUDE_4_5_SONNET_THINKING",
        335 => "MODEL_CHAT_GPT_5",
        336 => "MODEL_CHAT_GPT_5_MINI",
        337 => "MODEL_CHAT_GPT_5_NANO",
        339 => "MODEL_CLAUDE_4_5_SONNET_1M",
        340 => "MODEL_CLAUDE_4_5_HAIKU",
        341 => "MODEL_CLAUDE_4_5_HAIKU_THINKING",
        342 => "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
        358 => "MODEL_GOOGLE_GEMINI_2_5_FLASH_IMAGE",
        367 => "MODEL_GOOGLE_GEMINI_COMPUTER_USE_EXPERIMENTAL",
        _ => return Some(format!("MODEL_ENUM_{}", val)),
    };
    Some(known.to_string())
}

/// Maps `exa.codeium_common_pb.APIProvider` enum integers to their canonical names.
pub fn api_provider_to_str(val: i32) -> String {
    match val {
        0 => "API_PROVIDER_UNSPECIFIED".to_string(),
        1 => "API_PROVIDER_INTERNAL".to_string(),
        2 => "API_PROVIDER_OPENAI".to_string(),
        3 => "API_PROVIDER_GOOGLE_VERTEX".to_string(),
        4 => "API_PROVIDER_ANTHROPIC".to_string(),
        24 => "API_PROVIDER_GOOGLE_GEMINI".to_string(),
        26 => "API_PROVIDER_ANTHROPIC_VERTEX".to_string(),
        30 => "API_PROVIDER_GOOGLE_EVERGREEN".to_string(),
        31 => "API_PROVIDER_OPENAI_VERTEX".to_string(),
        32 => "API_PROVIDER_OPENAI_RESPONSES_VERTEX".to_string(),
        _ => format!("API_PROVIDER_{}", val),
    }
}

/// Maps `CortexStepStatus` enum integers to their canonical names.
pub fn step_status_to_str(status: i32) -> &'static str {
    match status {
        0 => "CORTEX_STEP_STATUS_UNSPECIFIED",
        1 => "CORTEX_STEP_STATUS_PENDING",
        2 => "CORTEX_STEP_STATUS_RUNNING",
        3 => "CORTEX_STEP_STATUS_DONE",
        4 => "CORTEX_STEP_STATUS_INVALID",
        5 => "CORTEX_STEP_STATUS_CLEARED",
        6 => "CORTEX_STEP_STATUS_CANCELED",
        7 => "CORTEX_STEP_STATUS_ERROR",
        8 => "CORTEX_STEP_STATUS_GENERATING",
        9 => "CORTEX_STEP_STATUS_WAITING",
        11 => "CORTEX_STEP_STATUS_QUEUED",
        12 => "CORTEX_STEP_STATUS_INTERRUPTED",
        _ => "CORTEX_STEP_STATUS_UNSPECIFIED",
    }
}

/// Maps `CortexStepType` enum integers to their canonical names, upgrading generic tool step 132
/// via `tool_call_name` to match `language_server.exe` RPC projection.
pub fn step_type_to_str(step_type: i32, tool_call_name: Option<&str>) -> String {
    if step_type == 132 {
        if let Some(tc) = tool_call_name {
            let mapped = match tc {
                "invoke_subagent" => Some("CORTEX_STEP_TYPE_INVOKE_SUBAGENT"),
                "read_file" | "view_file" => Some("CORTEX_STEP_TYPE_VIEW_FILE"),
                "run_command" => Some("CORTEX_STEP_TYPE_RUN_COMMAND"),
                "edit_file"
                | "write_file"
                | "write_to_file"
                | "replace_file_content"
                | "multi_replace_file_content" => Some("CORTEX_STEP_TYPE_CODE_ACTION"),
                "search_web" => Some("CORTEX_STEP_TYPE_SEARCH_WEB"),
                "list_dir" => Some("CORTEX_STEP_TYPE_LIST_DIRECTORY"),
                "grep_search" => Some("CORTEX_STEP_TYPE_GREP_SEARCH"),
                "find_by_name" => Some("CORTEX_STEP_TYPE_FIND"),
                "generate_image" => Some("CORTEX_STEP_TYPE_GENERATE_IMAGE"),
                "read_url_content" => Some("CORTEX_STEP_TYPE_READ_URL_CONTENT"),
                "view_content_chunk" => Some("CORTEX_STEP_TYPE_VIEW_CONTENT_CHUNK"),
                "command_status" => Some("CORTEX_STEP_TYPE_COMMAND_STATUS"),
                "send_command_input" => Some("CORTEX_STEP_TYPE_SEND_COMMAND_INPUT"),
                "view_file_outline" => Some("CORTEX_STEP_TYPE_VIEW_FILE_OUTLINE"),
                "view_code_item" => Some("CORTEX_STEP_TYPE_VIEW_CODE_ITEM"),
                "read_terminal" => Some("CORTEX_STEP_TYPE_READ_TERMINAL"),
                "load_skill" => Some("CORTEX_STEP_TYPE_LOAD_SKILL"),
                "task_boundary" => Some("CORTEX_STEP_TYPE_TASK_BOUNDARY"),
                "notify_user" => Some("CORTEX_STEP_TYPE_NOTIFY_USER"),
                "browser_subagent" => Some("CORTEX_STEP_TYPE_BROWSER_SUBAGENT"),
                "todo_list" => Some("CORTEX_STEP_TYPE_TODO_LIST"),
                _ => None,
            };
            if let Some(m) = mapped {
                return m.to_string();
            }
        }
        return "CORTEX_STEP_TYPE_GENERIC".to_string();
    }
    let known = match step_type {
        0 => "CORTEX_STEP_TYPE_UNSPECIFIED",
        1 => "CORTEX_STEP_TYPE_DUMMY",
        2 => "CORTEX_STEP_TYPE_FINISH",
        5 => "CORTEX_STEP_TYPE_VIEW_FILE",
        6 => "CORTEX_STEP_TYPE_CODE_ACTION",
        8 => "CORTEX_STEP_TYPE_GREP_SEARCH",
        9 => "CORTEX_STEP_TYPE_FIND",
        14 => "CORTEX_STEP_TYPE_USER_INPUT",
        15 => "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        17 => "CORTEX_STEP_TYPE_ERROR_MESSAGE",
        21 => "CORTEX_STEP_TYPE_RUN_COMMAND",
        23 => "CORTEX_STEP_TYPE_CHECKPOINT",
        28 => "CORTEX_STEP_TYPE_COMMAND_STATUS",
        31 => "CORTEX_STEP_TYPE_READ_URL_CONTENT",
        32 => "CORTEX_STEP_TYPE_VIEW_CONTENT_CHUNK",
        33 => "CORTEX_STEP_TYPE_SEARCH_WEB",
        47 => "CORTEX_STEP_TYPE_WORKSPACE_API",
        50 => "CORTEX_STEP_TYPE_SEND_COMMAND_INPUT",
        75 => "CORTEX_STEP_TYPE_BROWSER_SUBAGENT",
        81 => "CORTEX_STEP_TYPE_TASK_BOUNDARY",
        82 => "CORTEX_STEP_TYPE_NOTIFY_USER",
        85 => "CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE",
        89 => "CORTEX_STEP_TYPE_MCP_TOOL",
        90 => "CORTEX_STEP_TYPE_TODO_LIST",
        98 => "CORTEX_STEP_TYPE_GENERATE_IMAGE",
        99 => "CORTEX_STEP_TYPE_VIEW_FILE_OUTLINE",
        100 => "CORTEX_STEP_TYPE_VIEW_CODE_ITEM",
        101 => "CORTEX_STEP_TYPE_SYSTEM_MESSAGE",
        115 => "CORTEX_STEP_TYPE_READ_TERMINAL",
        118 => "CORTEX_STEP_TYPE_LOAD_SKILL",
        127 => "CORTEX_STEP_TYPE_INVOKE_SUBAGENT",
        131 => "CORTEX_STEP_TYPE_CHECKPOINT",
        132 => "CORTEX_STEP_TYPE_GENERIC",
        other => return format!("CORTEX_STEP_TYPE_{}", other),
    };
    known.to_string()
}

/// Maps subagent model tier enum integers to their canonical names.
pub fn model_tier_to_str(tier: i32) -> Option<&'static str> {
    match tier {
        1 => Some("MODEL_TIER_INHERIT"),
        2 => Some("MODEL_TIER_FLASH_LITE"),
        3 => Some("MODEL_TIER_FLASH"),
        4 => Some("MODEL_TIER_PRO"),
        _ => None,
    }
}

/// Maps task boundary agent mode enum integers to their canonical names.
pub fn agent_mode_to_str(mode: i32) -> Option<&'static str> {
    match mode {
        1 => Some("AGENT_MODE_PLANNING"),
        2 => Some("AGENT_MODE_EXECUTION"),
        3 => Some("AGENT_MODE_VERIFICATION"),
        _ => None,
    }
}
