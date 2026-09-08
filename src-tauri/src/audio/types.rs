use std::path::PathBuf;

#[derive(Clone, Debug)]
pub(crate) struct LiveAudioChunk {
    pub index: u32,
    pub mixed_path: Option<PathBuf>,
    pub microphone_path: Option<PathBuf>,
    pub error: Option<String>,
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct DeviceStatus {
    pub mic_available: bool,
    pub mic_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mic_display_name: Option<String>,
    pub system_audio_available: bool,
    pub system_audio_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_audio_display_name: Option<String>,
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct AudioDeviceInfo {
    pub raw_name: String,
    pub display_name: String,
    pub device_type: String,
    pub is_default: bool,
}
