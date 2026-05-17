# sd-webui-grimoire-bridge

Extension for AUTOMATIC1111 / Forge / SD.Next that lets [grimoire](https://github.com/omamesamba-del/grimoire) send prompts and generation settings directly to the WebUI.

## Compatible WebUIs

- AUTOMATIC1111 WebUI
- Forge / Forge Neo
- SD.Next

## Installation

```bash
cd extensions
git clone https://github.com/omamesamba-del/sd-webui-grimoire-bridge.git
```

Restart the WebUI. No other setup required.

## Setup in grimoire

1. Open **Settings → Generation**
2. Set **WebUI URL** (default: `http://127.0.0.1:7860`)
3. Enable **Send Prompt** and/or **Send Gen Settings** as needed

## How It Works

grimoire sends prompts to the bridge via `POST /pb/send`. A JavaScript polling loop running inside the WebUI page detects the request and fills the txt2img prompt fields — then optionally clicks Generate.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/pb/send` | Receive prompt + gen settings from grimoire |
| `GET` | `/pb/poll` | Polled by the WebUI JS to pick up pending requests |
| `GET` | `/pb/health` | Health check (returns version and backend type) |
| `POST` | `/pb/push-state` | WebUI JS pushes current state (checkpoint, sampler, etc.) |
| `GET` | `/pb/get-state` | grimoire fetches the current WebUI state |

## Notes

- The extension is passive — it does not interfere with the generation pipeline
- Works with `--api` flag **not** required (uses Gradio's internal FastAPI)

---

> **Note:** This extension was developed with the assistance of AI (Claude by Anthropic).

## License

MIT
