# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# ai-integration
- Replace AWS Bedrock with OpenAI-compatible API (e.g., DeepInfra) for chat completions, supporting both streaming and non-streaming. Design the integration to be provider-agnostic — any OpenAI-compatible endpoint should work by changing base URL, API key, and model name. Confidence: 0.75

# audio-recording
- Audio recording must work out-of-the-box with zero additional user setup or downloads — no virtual audio drivers (e.g., BlackHole, SoundFlower) should be required on any platform. Target native system audio capture comparable to Google Meet/Zoom/Discord. Confidence: 0.80
