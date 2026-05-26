/**
 * grimoire Bridge — WebUI Frontend v1.3.5
 * Compatible with: AUTOMATIC1111 WebUI / SD.Next / Forge / Forge Neo
 * Polls /pb/poll for pending prompts and fills txt2img form + clicks Generate.
 * State is pushed on-demand only (when grimoire requests it via /pb/request-state).
 */
(function () {
    'use strict';

    const POLL_INTERVAL_MS = 500;
    const STARTUP_DELAY_MS = 1500;
    const VERSION = '1.3.6';

    // ── DOM ヘルパー ──────────────────────────────────────────────────────────

    /** Gradio のルート要素を返す（shadow DOM 対応・Forge Neo 対応） */
    function gradioApp() {
        const el = document.querySelector('gradio-app');
        if (el) return el.shadowRoot || el;
        // Forge Neo / React フロントエンド向けフォールバック
        return document.body;
    }

    /**
     * 複数セレクタを順番に試し、最初にヒットした要素を返す。
     * 第1引数に root 要素、以降にセレクタ文字列を渡す。
     */
    function findFirst(root, ...selectors) {
        for (const sel of selectors) {
            try {
                const el = root.querySelector(sel);
                if (el) return el;
            } catch (_) {}
        }
        return null;
    }

    /** テキストエリアを Gradio の state を壊さずに書き換える */
    function setTextarea(el, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ── 要素取得ヘルパー（A1111 / Forge / Forge Neo 対応フォールバック） ────

    function getPositiveTextarea(root) {
        return findFirst(root,
            '#txt2img_prompt textarea',
            '#txt2img_toprow_prompt textarea',
            // Forge Neo が採用する可能性のある新 ID
            '#txt2img-prompt textarea',
            '[id^="txt2img"][id$="prompt"]:not([id*="neg"]) textarea',
        );
    }

    function getNegativeTextarea(root) {
        return findFirst(root,
            '#txt2img_neg_prompt textarea',
            '#txt2img_toprow_negative_prompt textarea',
            '#txt2img-neg-prompt textarea',
            '[id^="txt2img"][id*="neg"] textarea',
        );
    }

    function getGenerateBtn(root) {
        return findFirst(root,
            '#txt2img_generate',
            'button#txt2img_generate',
            // Forge Neo ボタン ID パターン
            '[id$="_generate"][id^="txt2img"]',
            'button[id*="txt2img"][id*="generate"]',
        );
    }

    function getInterruptBtn(root) {
        return findFirst(root,
            '#txt2img_interrupt',
            '[id$="_interrupt"][id^="txt2img"]',
            'button[id*="txt2img"][id*="interrupt"]',
        );
    }

    // ── State 読み取り（複数 ID フォールバック） ─────────────────────────────

    /** 数値 Gradio コンポーネントから値を読む（複数 ID 対応） */
    function readNum(root, ...ids) {
        for (const id of ids) {
            const el = root.querySelector(`#${id}`);
            if (!el) continue;
            const inp = el.querySelector('input[type="number"]') || el.querySelector('input');
            if (!inp) continue;
            const v = parseFloat(inp.value);
            if (!isNaN(v)) return v;
        }
        return undefined;
    }

    /** ドロップダウン / select から現在値を読む（複数 ID 対応） */
    function readDropdown(root, ...ids) {
        for (const id of ids) {
            const el = root.querySelector(`#${id}`);
            if (!el) continue;
            // パターン①: native select
            const sel = el.querySelector('select');
            if (sel && sel.value) return sel.value;
            // パターン②: Gradio 4 カスタムドロップダウン (input[type="text"])
            const inp = el.querySelector('input[type="text"]');
            if (inp && inp.value) return inp.value;
            // パターン③: ボタン式 (selected / aria-selected)
            const btn = el.querySelector('button.selected, [aria-selected="true"]');
            if (btn && btn.textContent.trim()) return btn.textContent.trim();
        }
        return undefined;
    }

    /** checkbox から checked を読む（複数 ID 対応） */
    function readCheckbox(root, ...ids) {
        for (const id of ids) {
            const el = root.querySelector(`#${id}`);
            if (!el) continue;
            const cb = el.querySelector('input[type="checkbox"]');
            if (cb) return cb.checked;
        }
        return undefined;
    }

    // ── 数値 / ドロップダウン / チェックボックス 書き込みヘルパー ─────────────

    /** Gradio の数値スライダーに値をセットして input/change イベントを発火する */
    function setNum(root, id, value) {
        if (value == null || isNaN(value)) return;
        const el = root.querySelector(`#${id}`);
        if (!el) return;
        const inp = el.querySelector('input[type="number"]') || el.querySelector('input');
        if (!inp) return;
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inp, String(value));
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** Gradio のドロップダウンに値をセットする（select / カスタム input / Gradio 4 クリック対応） */
    function setDropdown(root, value, ...ids) {
        if (value == null) return;
        for (const id of ids) {
            const el = root.querySelector(`#${id}`);
            if (!el) continue;
            // パターン①: native select
            const sel = el.querySelector('select');
            if (sel) {
                const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
                nativeSetter.call(sel, value);
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }
            // パターン②: Gradio 4 カスタムドロップダウン (input[type="text"])
            const inp = el.querySelector('input[type="text"]');
            if (inp) {
                // フォーカス＆クリックでドロップダウンを開く
                inp.focus();
                inp.click();
                // オプションリストが表示されるまで待ってからクリック選択
                const tryClick = (attemptsLeft) => {
                    // Gradio バージョン / フォークによってリスト構造が異なるため複数セレクタを試す
                    const OPTION_SELECTORS = [
                        'ul.options li',
                        '.options li',
                        'li.item',
                        '[role="option"]',
                        'li[role="option"]',
                        'ul[role="listbox"] li',
                        '[role="listbox"] [role="option"]',
                        'div.options > div',
                        '.dropdown-wrapper li',
                        'ul li',  // 最終フォールバック（要素内のみ）
                    ];
                    let items = [];
                    // まずコンテナ内を探す
                    for (const sel of OPTION_SELECTORS) {
                        const found = Array.from(el.querySelectorAll(sel));
                        if (found.length > 0) { items = found; break; }
                    }
                    // なければ document 全体を探す（portal 対応）—"ul li" は除く
                    if (items.length === 0) {
                        for (const sel of OPTION_SELECTORS.slice(0, -1)) {
                            const found = Array.from(document.querySelectorAll(sel));
                            if (found.length > 0) { items = found; break; }
                        }
                    }
                    const exact = items.find(it => it.textContent.trim() === value);
                    if (exact) { exact.click(); return; }
                    const partial = items.find(it => it.textContent.trim().includes(value) || value.includes(it.textContent.trim()));
                    if (partial) { partial.click(); return; }
                    if (attemptsLeft > 0) {
                        setTimeout(() => tryClick(attemptsLeft - 1), 60);
                    } else {
                        // フォールバック: input value を直接書き換えてイベント発火
                        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                        nativeSetter.call(inp, value);
                        inp.dispatchEvent(new Event('input',  { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                        inp.blur();
                        console.warn(`[grimoire Bridge] dropdown option not found: "${value}" in #${id}`);
                    }
                };
                setTimeout(() => tryClick(10), 60);
                return;
            }
        }
    }

    /** Gradio のチェックボックスに値をセットする */
    function setCheckbox(root, checked, ...ids) {
        if (checked == null) return;
        for (const id of ids) {
            const el = root.querySelector(`#${id}`);
            if (!el) continue;
            const cb = el.querySelector('input[type="checkbox"]');
            if (!cb) continue;
            if (cb.checked !== !!checked) {
                cb.click();
            }
            return;
        }
    }

    /**
     * モデル名のバリアント（basename、拡張子なし）で /sdapi/v1/sd-models を検索し、
     * WebUI が期待するフルタイトル（サブフォルダ付き）を返す。見つからなければ元の値を返す。
     */
    async function resolveModelTitle(value) {
        try {
            const res = await fetch('/sdapi/v1/sd-models');
            if (!res.ok) return value;
            const models = await res.json();
            // 完全一致（title）
            const exact = models.find(m => m.title === value || m.model_name === value);
            if (exact) return exact.title;
            // basename（拡張子なし）での曖昧一致
            const needle = value.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
            const fuzzy = models.find(m => {
                const hay = (m.title || '').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
                return hay === needle;
            });
            if (fuzzy) {
                console.log(`[grimoire Bridge] resolved checkpoint: "${value}" → "${fuzzy.title}"`);
                return fuzzy.title;
            }
        } catch (_) {}
        return value;
    }

    // 前回送信したチェックポイント（raw値）のキャッシュ。同一値なら送信をスキップする。
    let _lastSentCheckpoint = null;

    /**
     * /sdapi/v1/options 経由で Quick Setting を変更する。
     * checkpoint は /sdapi/v1/sd-models でフルタイトルを解決してから POST する。
     * 前回と同じ値なら送信をスキップする。
     */
    async function setCheckpointViaApi(value, domId) {
        if (value == null) return;
        if (value === _lastSentCheckpoint) {
            console.log(`[grimoire Bridge] checkpoint unchanged, skipping`);
            return;
        }
        const title = await resolveModelTitle(value);
        const res = await fetch('/sdapi/v1/options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sd_model_checkpoint: title }),
        }).catch(e => { console.warn('[grimoire Bridge] setCheckpointViaApi failed:', e); return null; });
        if (!res?.ok) { console.warn(`[grimoire Bridge] setCheckpointViaApi HTTP ${res?.status}`); return; }
        _lastSentCheckpoint = value; // 送信成功→キャッシュ更新

        // GET で実際の値を確認して Gradio 入力欄を更新
        const verify = await fetch('/sdapi/v1/options').catch(() => null);
        if (verify?.ok) {
            const opts = await verify.json();
            const actual = opts.sd_model_checkpoint;
            console.log(`[grimoire Bridge] checkpoint: requested="${title}" actual="${actual}"`);
            if (domId) {
                const root = gradioApp();
                const el = root.querySelector(`#${domId}`);
                const inp = el?.querySelector('input[type="text"]') || el?.querySelector('input');
                if (inp) {
                    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    nativeSetter.call(inp, actual || title);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }
    }

    function setOptionViaApi(key, value, domId) {
        if (value == null) return;
        fetch('/sdapi/v1/options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: value }),
        }).then(async (res) => {
            if (!res.ok) { console.warn(`[grimoire Bridge] setOptionViaApi(${key}) HTTP ${res.status}`); return; }
            console.log(`[grimoire Bridge] set ${key} = "${value}"`);
            if (domId) {
                const root = gradioApp();
                const el = root.querySelector(`#${domId}`);
                const inp = el?.querySelector('input[type="text"]') || el?.querySelector('input');
                if (inp) {
                    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    nativeSetter.call(inp, value);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }).catch(e => { console.warn(`[grimoire Bridge] setOptionViaApi(${key}) failed:`, e); });
    }

    /** gen オブジェクトの各フィールドを WebUI フォームに適用する */
    function applyGen(root, gen) {
        if (!gen) return;
        setNum(root, 'txt2img_steps',             gen.steps);
        setNum(root, 'txt2img_cfg_scale',          gen.cfg);
        setNum(root, 'txt2img_width',              gen.width);
        setNum(root, 'txt2img_height',             gen.height);
        setNum(root, 'txt2img_seed',               gen.seed);
        setNum(root, 'txt2img_batch_count',        gen.batchCount);
        setNum(root, 'txt2img_batch_size',         gen.batchSize);
        setNum(root, 'txt2img_hires_steps',        gen.hiresSteps);
        setNum(root, 'txt2img_denoising_strength', gen.hiresDenoising);
        setNum(root, 'txt2img_hr_scale',           gen.hiresUpscaleBy);
        setDropdown(root, gen.sampler,       'txt2img_sampling', 'txt2img_sampler_name', 'txt2img_sampler');
        setDropdown(root, gen.schedule,      'txt2img_scheduler', 'txt2img_scheduler_type');
        setDropdown(root, gen.hiresUpscaler, 'txt2img_hr_upscaler', 'txt2img_hr_upscaler_name');
        setCheckbox(root, gen.hiresFix,      'txt2img_enable_hr', 'txt2img_hr_enable');
        // checkpoint / vae は Gradio 4 DOM では変更不可のため API 経由で変更
        // checkpoint はサブフォルダ付きのフルタイトルを解決してから POST
        if (gen.checkpoint) setCheckpointViaApi(gen.checkpoint, 'setting_sd_model_checkpoint');
        setOptionViaApi('sd_vae', gen.vae, 'setting_sd_vae');
        if (gen.clipSkip != null && !isNaN(gen.clipSkip)) {
            setNum(root, 'setting_CLIP_stop_at_last_layers', gen.clipSkip);
        }
    }

    // ── プロンプト適用 ────────────────────────────────────────────────────────

    function applyPrompt(data) {
        const root  = gradioApp();
        const posEl = getPositiveTextarea(root);
        const negEl = getNegativeTextarea(root);

        if (!posEl || !negEl) {
            console.warn('[PB Bridge] txt2img の prompt textarea が見つかりません。WebUI が完全に読み込まれるまで待ってください。');
            return;
        }

        if (data.mode === 'generate-only') {
            // プロンプトは変更せず Generate だけクリック
        } else if (data.mode === 'append') {
            const posSep = posEl.value.trim() ? ', ' : '';
            const negSep = negEl.value.trim() ? ', ' : '';
            setTextarea(posEl, posEl.value + posSep + (data.positive || ''));
            if (data.negative) setTextarea(negEl, negEl.value + negSep + data.negative);
        } else {
            // overwrite
            setTextarea(posEl, data.positive || '');
            setTextarea(negEl, data.negative || '');
        }

        // gen 設定を WebUI フォームに適用
        if (data.gen) applyGen(root, data.gen);

        if (data.trigger !== false) {
            setTimeout(() => {
                const root2 = gradioApp();
                const btn = getGenerateBtn(root2);
                if (!btn) {
                    console.warn('[PB Bridge] Generate ボタンが見つかりません。');
                    return;
                }
                // 生成中（Interrupt ボタン表示中 かつ Generate ボタン非表示）のときのみスキップ
                const interrupt = getInterruptBtn(root2);
                const interruptVisible = interrupt && interrupt.offsetParent !== null && getComputedStyle(interrupt).display !== 'none';
                const generateHidden  = btn.offsetParent === null || getComputedStyle(btn).display === 'none' || btn.disabled;
                if (interruptVisible && generateHidden) {
                    console.warn('[PB Bridge] WebUI は生成中のため Generate をスキップしました。');
                    return;
                }
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            }, 400);
        }
    }

    // ── ポーリング ────────────────────────────────────────────────────────────

    async function poll() {
        try {
            const res = await fetch('/pb/poll');
            if (res.ok) {
                const data = await res.json();
                if (data) {
                    if (data.__state_request__) {
                        pushStateNow();
                        const { __state_request__: _, ...rest } = data;
                        if (Object.keys(rest).length > 0) applyPrompt(rest);
                    } else {
                        applyPrompt(data);
                    }
                }
            }
        } catch (_) {
            // WebUI がまだ起動中などは無視
        }
        setTimeout(poll, POLL_INTERVAL_MS);
    }

    // ── State push (WebUI → grimoire) ────────────────────────────────────────

    function readCurrentState() {
        const root  = gradioApp();
        const posEl = getPositiveTextarea(root);
        const negEl = getNegativeTextarea(root);
        if (!posEl) return null;

        return {
            positive: posEl.value,
            negative: negEl ? negEl.value : '',
            gen: {
                steps:          readNum(root, 'txt2img_steps'),
                cfg:            readNum(root, 'txt2img_cfg_scale'),
                width:          readNum(root, 'txt2img_width'),
                height:         readNum(root, 'txt2img_height'),
                seed:           readNum(root, 'txt2img_seed'),
                batchCount:     readNum(root, 'txt2img_batch_count'),
                batchSize:      readNum(root, 'txt2img_batch_size'),
                // サンプラー: A1111=txt2img_sampling, Forge/Forge Neo=txt2img_sampler_name or txt2img_sampler
                sampler:        readDropdown(root, 'txt2img_sampling', 'txt2img_sampler_name', 'txt2img_sampler'),
                // スケジューラー: A1111/Forge=txt2img_scheduler, Forge Neo=txt2img_scheduler_type
                schedule:       readDropdown(root, 'txt2img_scheduler', 'txt2img_scheduler_type'),
                hiresFix:       readCheckbox(root, 'txt2img_enable_hr', 'txt2img_hr_enable'),
                hiresUpscaler:  readDropdown(root, 'txt2img_hr_upscaler', 'txt2img_hr_upscaler_name'),
                hiresSteps:     readNum(root, 'txt2img_hires_steps', 'txt2img_hr_steps'),
                hiresDenoising: readNum(root, 'txt2img_denoising_strength', 'txt2img_hr_denoising_strength'),
                hiresUpscaleBy: readNum(root, 'txt2img_hr_scale'),
            },
        };
    }

    async function pushStateNow() {
        try {
            const state = readCurrentState();
            if (state) {
                await fetch('/pb/push-state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(state),
                });
            }
        } catch (_) {}
    }

    setTimeout(poll, STARTUP_DELAY_MS);
    console.log(`[grimoire Bridge] loaded v${VERSION}`);
})();
