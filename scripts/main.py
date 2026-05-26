"""
grimoire Bridge — WebUI Extension v1.3.5
Compatible with: AUTOMATIC1111 WebUI / SD.Next / Forge / Forge Neo
Receives prompt from grimoire app and fills txt2img form + clicks Generate.
"""
import queue
import gradio as gr
from modules import script_callbacks
from fastapi import FastAPI
from pydantic import BaseModel

try:
    import modules.scripts as scripts
    _HAS_SCRIPTS = True
except Exception:
    _HAS_SCRIPTS = False

_BRIDGE_VERSION = "1.4.0"
_pending: queue.Queue = queue.Queue()
_last_state: dict = {}          # bridge.js から push される最新の WebUI 状態
_state_requested: bool = False  # grimoire からのオンデマンド取得フラグ


def _detect_backend() -> str:
    """実行中の WebUI バックエンドを判定して文字列で返す。"""
    try:
        from modules import shared
        # Forge Neo は cmd_opts に forge_neo 属性を持つ場合がある
        if hasattr(shared, 'cmd_opts') and getattr(shared.cmd_opts, 'forge_neo', False):
            return "forge-neo"
        # Forge は version 文字列に "forge" を含む場合が多い
        if hasattr(shared, 'versions') and isinstance(shared.versions, dict):
            v = str(shared.versions.get('app', '')).lower()
            if 'forge' in v:
                return "forge"
        # SD.Next
        if hasattr(shared, 'backend'):
            return "sdnext"
    except Exception:
        pass
    return "a1111"


def _is_busy() -> bool:
    """生成中かどうかを複数のバックエンド API で確認する。"""
    try:
        from modules import shared
        state = shared.state
        # 中断済み・停止済みなら busy とみなさない
        if getattr(state, 'interrupted', False) or getattr(state, 'stopping_generation', False):
            return False
        # A1111 / Forge 共通: job_count
        if hasattr(state, 'job_count') and state.job_count > 0:
            return True
        # Forge Neo / SD.Next: current_latent が存在するとき生成中
        if hasattr(state, 'current_latent') and state.current_latent is not None:
            return True
        # processing フラグ (一部フォーク)
        if getattr(state, 'processing', False):
            return True
    except Exception:
        pass
    return False


class PromptRequest(BaseModel):
    positive: str = ""
    negative: str = ""
    mode: str = "overwrite"   # "overwrite" | "append"
    trigger: bool = True       # True = click Generate after filling
    gen: dict = None           # generation settings (steps, cfg, sampler, etc.)


def on_app_started(_demo: gr.Blocks, app: FastAPI):
    # app が None の WebUI フォーク対策
    if app is None:
        return

    @app.post("/pb/send")
    async def send(req: PromptRequest):
        # Generate トリガーが要求されているとき、生成中なら拒否
        if req.trigger and _is_busy():
            return {"status": "busy", "error": "WebUI は生成中です。"}
        _pending.put(req.dict())
        return {"status": "queued", "queue_size": _pending.qsize()}

    @app.post("/pb/reset-busy")
    async def reset_busy():
        """stuck した busy 状態をリセットする。"""
        try:
            from modules import shared
            shared.state.job_count = 0
            shared.state.current_latent = None
        except Exception:
            pass
        return {"status": "ok"}

    @app.get("/pb/poll")
    async def poll():
        global _state_requested
        try:
            item = _pending.get_nowait()
        except queue.Empty:
            item = None
        # state_requested フラグを piggyback して bridge.js に伝える
        if _state_requested:
            _state_requested = False
            return {"__state_request__": True, **(item or {})}
        return item

    @app.post("/pb/request-state")
    async def request_state():
        """grimoire がインポートボタンを押したときに呼ぶ。次の poll で bridge.js に通知する。"""
        global _state_requested, _last_state
        _state_requested = True
        _last_state = {}  # 古いキャッシュをクリア、フレッシュな push を待つ
        return {"status": "requested"}

    @app.post("/pb/push-state")
    async def push_state(state: dict):
        global _last_state
        _last_state = state
        return {"status": "ok"}

    @app.get("/pb/get-state")
    async def get_state():
        if not _last_state:
            return None
        result = dict(_last_state)
        return result

    @app.get("/pb/health")
    async def health():
        return {
            "status": "ok",
            "version": _BRIDGE_VERSION,
            "name": "grimoire-bridge",
            "backend": _detect_backend(),
        }


script_callbacks.on_app_started(on_app_started)


# scripts/ フォルダに置く場合は Script サブクラスが必要。
# AlwaysVisible にすることで after_component() が呼ばれ、sampler/scheduler
# コンポーネントを Python 経由で更新するためのトリガー Textbox を仕込む。
if _HAS_SCRIPTS:
    class GrimoireBridgeScript(scripts.Script):
        def __init__(self):
            self._sampler  = {}   # prefix -> gr.Radio / gr.Dropdown
            self._scheduler = {}  # prefix -> gr.Dropdown

        def title(self):
            return "grimoire Bridge"

        def show(self, is_img2img):
            return scripts.AlwaysVisible

        def ui(self, is_img2img):
            return []

        def after_component(self, component, **kwargs):
            eid = getattr(component, 'elem_id', '')
            for prefix in ('txt2img', 'img2img'):
                if eid == f'{prefix}_sampling':
                    self._sampler[prefix] = component
                elif eid == f'{prefix}_scheduler':
                    self._scheduler[prefix] = component

            if eid == 'txt2img_generation_info_button':
                self._create_triggers('txt2img')
            elif eid == 'img2img_generation_info_button':
                self._create_triggers('img2img')

        def _create_triggers(self, prefix):
            sampler_comp   = self._sampler.get(prefix)
            scheduler_comp = self._scheduler.get(prefix)

            fn = lambda v: gr.update(value=v) if v else gr.update()

            with gr.Row(visible=False):
                t_s = gr.Textbox(value='', label='',
                                 elem_id=f'grimoire_{prefix}_sampler_trigger',
                                 interactive=True)
                t_c = gr.Textbox(value='', label='',
                                 elem_id=f'grimoire_{prefix}_scheduler_trigger',
                                 interactive=True)

            if sampler_comp is not None:
                t_s.input(fn=fn, inputs=[t_s], outputs=[sampler_comp], show_progress=False)
            if scheduler_comp is not None:
                t_c.input(fn=fn, inputs=[t_c], outputs=[scheduler_comp], show_progress=False)

        def run(self, p, *args):
            pass
