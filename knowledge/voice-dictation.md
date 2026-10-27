# Optional local dictation

Dictation puts recognized text into the focused terminal or text field.
bunnyUFO Workspace's voice assistant instead carries on a conversation and can call tools.
You can use either, both or neither.

[Wispr Local](https://github.com/nsoth/wispr-local) is one Windows option built
around whisper.cpp. Review its language and GPU build defaults before installing.
Follow its README to select English and settings appropriate for the recipient's
machine. The project also documents optional
cloud text formatting. This template includes setup instructions, not a bundled
copy of Wispr Local or another user's customized build.

Use a separate folder for the dictation app. Start with the language you actually
speak and a model that fits your memory budget. Verify recognition in a text
editor before testing it in an agent terminal. A successful microphone recording
does not prove that text injection reached the intended window.

Choose a non-conflicting push-to-talk shortcut. Test silence, a short phrase,
technical names and several recordings in succession. Do not auto-submit text
while diagnosing dictation. Keep cloud formatting off for a fully local
transcription workflow; enabling it sends recognized text to that provider.

Record the chosen model, build settings and recovery steps in a local setup
note. Leave microphone recordings, transcripts and credentials out of a public
handoff. Always check upstream instructions again on the recipient's machine.
