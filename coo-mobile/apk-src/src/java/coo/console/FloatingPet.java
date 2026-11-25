package coo.console;

import android.animation.ValueAnimator;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;

/**
 * A pet-sized draggable overlay window that keeps the figure on the phone's home screen.
 *
 * v1.5: long-pressing the pet used to open WebView's own context menu, which was
 * clipped by the small window. The long press is now consumed and a slim vertical
 * action bar appears to the RIGHT of the pet; the window temporarily grows to hold
 * it, so nothing is cut off, and shrinks back when the bar is dismissed.
 *
 * v1.6: when a soft keyboard shows up, the pet hops to just above its top edge
 * and springs back to its old spot once the keyboard hides. Three independent
 * sources report keyboard state (this overlay, the app's own window, and an
 * optional accessibility service for other apps); see recomputeIme().
 *
 * v1.7: speech is drawn by a SEPARATE, non-touchable native window instead of
 * reusing the desktop page's .bubble element. Text arrives through the pet
 * page's socket bridge, is typed one character at a time, holds for 0.3s by
 * default and fades away; both timings are adjustable from the app menu.
 * The side action bar now opens on a quick triple tap only - dragging the pet
 * never opens it (or WebView's own context menu).
 *
 * v1.8: the little x dot in the top-right corner of the pet is gone. Closing
 * now lives exclusively in the vertical action bar, whose first row is a
 * highlighted "x close" button; the pet itself is fully transparent to taps
 * except for dragging and the triple tap.
 *
 * v1.9: a window drag used to leak ACTION_DOWN into the page, whose body kit
 * grabs the figure after just 6px. Since Java ate the following MOVE/UP, the
 * model never got a pointerup and stayed in its "carried" pose in mid-air.
 * The drag now consumes the entire gesture; short taps are replayed as
 * synthetic pointer events, and on release __cooSettle() returns the body to a
 * calm standing pose on the floor while applyBox() holds its vertical offset.
 *
 * v2.3: the little window is a crop of the full stage, centred on the body box.
 * A tap makes her hop, which used to lift the box above the stage (y < 0);
 * applyBox() discarded those frames and the 160ms/0.22 follow lagged behind,
 * so the top of the figure was cut off. The page now feeds the clamped box on
 * almost every frame, negative y is handled instead of dropped, positive
 * translations are allowed and the follow is firm (0.7). The native window
 * itself never moves - only the crop follows the body.
 *
 * v2.5: that firm follow was too good - it cancelled the hop visually, so she
 * looked frozen on screen. applyBox() now leaves the crop ALONE while the body
 * is safely inside it, only nudging the content when a head or feet would leave
 * the little window, and drifts back to centre once she has landed. A bit more
 * head-room (JUMP_ROOM_DP) makes the hop visible without clipping. The action
 * bar gained a "chat" row that opens the native ChatActivity. While the screen
 * is off, PowerSave pauses this WebView, its JS timers, the keyboard probe and
 * the bubble typing loop, so an idle phone no longer burns battery on a pet
 * nobody can see.
 */
public final class FloatingPet {

    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static final long TRIPLE_TAP_WINDOW_MS = 850L;
    private static final long TAP_GAP_MS = 320L;
    private static final long TAP_DOWN_MAX_MS = 280L;

    private static final String PREFS_BUBBLE = "coo_pet_bubble";
    private static final String KEY_CHAR_MS = "char_ms";
    private static final String KEY_HOLD_MS = "hold_ms";
    private static final long DEFAULT_CHAR_MS = 45L;
    private static final long DEFAULT_HOLD_MS = 300L;

    // Keyboard state sources. All of them feed the same state machine; a report
    // older than IME_SOURCE_TTL is treated as "no keyboard" so the pet always
    // comes back even if the reporting window stopped sending callbacks.
    public static final int IME_SRC_SELF = 0;
    public static final int IME_SRC_APP = 1;
    public static final int IME_SRC_ACC = 2;
    private static final long IME_SOURCE_TTL = 1800L;
    private static final long IME_TICK_MS = 220L;
    private static final boolean[] imeShown = new boolean[3];
    private static final int[] imeTop = new int[3];
    private static final long[] imeAt = new long[3];
    private static final Rect IME_RECT = new Rect();

    private static Context appCtx;
    private static View root;
    private static WebView web;
    private static WindowManager manager;
    private static WindowManager.LayoutParams params;
    private static FrameLayout container;
    private static LinearLayout actionBar;

    private static String petUrlToLoad = "";
    private static String lastError = "";
    private static volatile String lastStatus = "";
    private static boolean seeThrough = true;   // transparent by default: the window is pet-sized
    private static boolean fullStage = false;   // fallback: the old large stage-sized window
    private static boolean barVisible = false;

    // Native speech bubble: its own window so it is never clipped by the
    // pet-sized window and never intercepts a touch.
    private static View bubbleRoot;
    private static TextView bubbleLabel;
    private static WindowManager.LayoutParams bubbleParams;
    private static final ArrayDeque<String> bubbleLines = new ArrayDeque<>();
    private static String bubbleMessage = "";
    private static int bubbleCursor = 0;
    private static long charMs = DEFAULT_CHAR_MS;
    private static long holdMs = DEFAULT_HOLD_MS;

    private static float density = 1f;
    private static int screenW, screenH, stageW, stageH, winW, winH;
    private static int barW, barH, barShiftX, savedX = -1, savedY = -1;
    private static float curTx, curTy;
    private static long lastResizeAt = 0L;

    // --- v2.5: visible hops -----------------------------------------------
    /** Extra height (dp) above/below the body box so a hop can be seen in the crop. */
    private static final int JUMP_ROOM_DP = 44;
    /** Keep this much (dp) of the window clear when nudging the crop back. */
    private static final int EDGE_PAD_DP = 6;
    private static boolean boxReady = false;
    private static float lastCentreY = -1f;
    private static long lastBoxMoveAt = 0L;

    // --- v2.5: screen-off power saving ------------------------------------
    private static boolean screenOff = false;

    // --- drag settling ----------------------------------------------------
    // While the finger is down the desktop body model must not see the touch at
    // all: its "grab" threshold is only 6px, so a window drag used to leave the
    // figure hanging in mid-air forever (it never got a pointerup). On release
    // we put her back into a calm standing pose and hold the window's vertical
    // offset steady for a moment so the model cannot yank her up again.
    private static long standUntil = 0L;
    private static float standTy = 0f;

    // --- keyboard hopping -------------------------------------------------
    private static boolean imeFollow = true;        // user-facing on/off switch
    private static boolean imeActive = false;       // keyboard is up right now
    private static boolean imeRestore = false;      // put the pet back on hide
    private static int imeSavedY = -1;
    private static int imeBaseline = 0;             // visible bottom without IME
    private static ValueAnimator imeAnim;
    private static boolean imeTickRunning = false;

    private FloatingPet() { }

    public static boolean isShowing() { return root != null; }
    public static String lastError() { return lastError; }
    public static String lastStatus() { return lastStatus; }
    public static boolean isSeeThrough() { return seeThrough; }
    public static boolean isFullStage() { return fullStage; }
    public static void setFullStage(boolean value) { fullStage = value; }
    public static boolean isImeFollowEnabled() { return imeFollow; }
    public static boolean isImeActive() { return imeActive; }

    // ------------------------------------------------------- bubble settings

    public static long charMillis(Context c) {
        return prefs(c).getLong(KEY_CHAR_MS, DEFAULT_CHAR_MS);
    }

    public static long holdMillis(Context c) {
        return prefs(c).getLong(KEY_HOLD_MS, DEFAULT_HOLD_MS);
    }

    public static void setTimings(Context c, long perChar, long hold) {
        charMs = clampL(perChar, 10L, 1000L);
        holdMs = clampL(hold, 0L, 10000L);
        prefs(c).edit().putLong(KEY_CHAR_MS, charMs)
                .putLong(KEY_HOLD_MS, holdMs).apply();
    }

    /** Used by the menu so the user can check the look without waiting for Coo. */
    public static void testBubble() {
        showSpeech("{\"lines\":[\"你好呀，我是 Coo～点三下可以叫出菜单\"]}");
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(
                PREFS_BUBBLE, Context.MODE_PRIVATE);
    }

    private static long clampL(long v, long lo, long hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    public static boolean canOverlay(Context context) {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(context);
    }

    public static void requestPermission(Context context) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception ignored) { }
    }

    /** Toggle a transparent vs. a visible tinted backdrop. */
    public static void toggleBackground() {
        seeThrough = !seeThrough;
        applyBackdrop();
    }

    private static void applyBackdrop() {
        if (container == null) {
            return;
        }
        container.setBackgroundColor(seeThrough
                ? Color.TRANSPARENT
                : Color.parseColor("#59152128"));
    }

    public static void toggle(Context context, String petUrl) {
        if (isShowing()) {
            hide();
        } else {
            show(context.getApplicationContext(), petUrl);
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility", "AddJavascriptInterface"})
    private static void show(final Context app, final String petUrl) {
        lastError = "";
        appCtx = app;
        manager = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
        if (manager == null) {
            lastError = "取不到 WindowManager";
            return;
        }

        DisplayMetrics dm = new DisplayMetrics();
        manager.getDefaultDisplay().getMetrics(dm);
        density = dm.density;
        screenW = dm.widthPixels;
        screenH = dm.heightPixels;

        // The WebView keeps this full stage: the figure is sized and placed in
        // stage coordinates, so shrinking the viewport would break its layout.
        stageW = Math.min(dp(app, 340), screenW - dp(app, 12));
        stageH = dp(app, 430);

        if (fullStage) {
            winW = stageW;
            winH = stageH;
        } else {
            // ~86x99 CSS px body box + head-room for a visible hop (v2.5),
            // refined by applyBox() once the page reports its real box.
            winW = Math.min(dp(app, 112), screenW - dp(app, 16));
            winH = Math.min(dp(app, 148), screenH - dp(app, 16));
        }
        barW = dp(app, 40);
        barH = dp(app, 21) * 7;            // 7 rows now that "chat" is in the bar
        barVisible = false;
        barShiftX = 0;
        lastResizeAt = 0L;
        charMs = charMillis(app);
        holdMs = holdMillis(app);
        boxReady = false;
        lastCentreY = -1f;
        lastBoxMoveAt = 0L;
        screenOff = PowerSave.isScreenOff();
        resetImeState();

        final int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        int flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;

        params = new WindowManager.LayoutParams(
                winW, winH, type, flags, PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        if (savedX >= 0) {
            params.x = clampI(savedX, dp(app, 8), screenW - winW - dp(app, 8));
            params.y = clampI(savedY, dp(app, 40), screenH - winH - dp(app, 40));
        } else {
            params.x = Math.max(dp(app, 8), screenW - winW - dp(app, 14));
            params.y = Math.max(dp(app, 40), screenH - winH - dp(app, 150));
        }

        container = new FrameLayout(app);
        container.setClipChildren(false);
        applyBackdrop();

        web = new WebView(app);
        web.setBackgroundColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        configure(web, petUrl);
        PowerSave.attach(web);

        FrameLayout.LayoutParams webLp = new FrameLayout.LayoutParams(stageW, stageH);
        webLp.gravity = Gravity.TOP | Gravity.START;
        container.addView(web, webLp);

        // Before the first frame report, aim at the figure's resting place
        // (70% across the stage, standing near the floor).
        if (fullStage) {
            curTx = 0f;
            curTy = 0f;
        } else {
            curTx = clampF(winW / 2f - (stageW * 0.7f + dp(app, 43)), winW - stageW, 0f);
            curTy = clampF(winH / 2f - (stageH - dp(app, 98)), winH - stageH, 0f);
        }
        web.setTranslationX(curTx);
        web.setTranslationY(curTy);
        attachDrag(web, ViewConfiguration.get(app).getScaledTouchSlop());

        // Swallow WebView's own context menu for good: it used to be clipped by
        // the pet-sized window and could also pop up while dragging. The action
        // bar is now opened by a quick triple tap, never by a long press.
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override public boolean onLongClick(View v) { return true; }
        });

        // No top-right x dot any more: closing is done from the action bar.
        actionBar = buildActionBar(app);

        root = container;
        try {
            manager.addView(root, params);
        } catch (Throwable e) {
            lastError = e.getClass().getSimpleName() + ": " + e.getMessage();
            root = null;
            if (web != null) {
                try { web.destroy(); } catch (Throwable ignored) { }
                web = null;
            }
            container = null;
            actionBar = null;
            return;
        }

        // Loading before attach leaves some WebViews with a live page but no
        // rendering surface. Wait for the window to be laid out first.
        petUrlToLoad = petUrl;
        if (!imeTickRunning) {
            imeTickRunning = true;
            UI.postDelayed(IME_TICK, IME_TICK_MS);
        }
        UI.postDelayed(new Runnable() {
            @Override public void run() {
                if (web != null && root != null) {
                    setStatus("正在加载桌宠页面 …");
                    web.loadUrl(petUrlToLoad);
                }
            }
        }, 350L);

        UI.postDelayed(new Runnable() {
            @Override public void run() { inject(); }
        }, 1500L);
        UI.postDelayed(new Runnable() {
            @Override public void run() { inject(); }
        }, 4000L);
        UI.postDelayed(new Runnable() {
            @Override public void run() { inject(); }
        }, 8000L);

        // Started while the phone is asleep? Go straight to the quiet state.
        if (screenOff) {
            onScreenOff();
        }
    }

    /** The slim vertical strip that sits to the RIGHT of the pet. */
    @SuppressLint("ClickableViewAccessibility")
    private static LinearLayout buildActionBar(final Context app) {
        LinearLayout bar = new LinearLayout(app);
        bar.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xE6152128);
        bg.setCornerRadius(dp(app, 8));
        bar.setBackground(bg);
        bar.setPadding(0, dp(app, 2), 0, dp(app, 2));

        // The first row is the former top-right x: it is the only close control
        // on the pet itself now, highlighted so it is easy to find.
        String[] labels = { "×关闭", "刷新", "背景", "状态", "尺寸", "对话", "收起" };
        for (int i = 0; i < labels.length; i++) {
            final int which = i;
            TextView item = new TextView(app);
            item.setText(labels[i]);
            item.setGravity(Gravity.CENTER);
            item.setClickable(true);
            if (i == 0) {
                GradientDrawable closeBg = new GradientDrawable();
                closeBg.setColor(0xFF4A222A);
                closeBg.setCornerRadius(dp(app, 7));
                closeBg.setStroke(1, 0x66FFB3B3);
                item.setBackground(closeBg);
                item.setTextColor(0xFFFFD9D9);
                item.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9);
            } else {
                item.setTextColor(0xFFD9F2ED);
                item.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
            }
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(app, 21));
            bar.addView(item, lp);
            item.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { onAction(which, app); }
            });
        }
        return bar;
    }

    private static FrameLayout.LayoutParams actionBarLayout(Context app) {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(barW, barH);
        lp.gravity = Gravity.TOP | Gravity.END;
        return lp;
    }

    private static void onAction(int which, Context app) {
        switch (which) {
            case 0:                       // 关闭
                hide();
                return;
            case 1:                       // 刷新
                if (web != null) {
                    web.reload();
                }
                setStatus("已刷新，正在重新加载 …");
                hideActions();
                return;
            case 2:                       // 背景
                toggleBackground();
                Toast.makeText(app, seeThrough ? "已切到透明背景" : "已切到可见背景",
                        Toast.LENGTH_SHORT).show();
                hideActions();
                return;
            case 3:                       // 状态
                Toast.makeText(app, lastStatus.isEmpty() ? "暂无运行状态" : lastStatus,
                        Toast.LENGTH_LONG).show();
                hideActions();
                return;
            case 4:                       // 尺寸：贴合 / 大框
                switchStageMode();
                return;
            case 5:                       // 对话：打开原生对话界面
                hideActions();
                openChat(app);
                return;
            default:                      // 收起
                hideActions();
        }
    }

    /**
     * Open ChatActivity straight from the floating pet. The console URL saved
     * by MainActivity is the only source of host + token, so this works even
     * when the main activity is not on screen any more. FLAG_ACTIVITY_NEW_TASK
     * is required because `app` here is the application context.
     */
    private static void openChat(Context app) {
        try {
            SharedPreferences p = app.getSharedPreferences("coo_console", Context.MODE_PRIVATE);
            String saved = p.getString("console_url", "");
            Uri u = Uri.parse(saved);
            String host = u.getHost() == null ? "" : u.getHost();
            String token = u.getQueryParameter("m");
            if (host.isEmpty() || token == null || token.isEmpty()) {
                Toast.makeText(app, "先在 App 里获取一次最新地址", Toast.LENGTH_SHORT).show();
                return;
            }
            Intent i = new Intent(app, ChatActivity.class)
                    .putExtra("chat_host", host)
                    .putExtra("chat_token", token)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            app.startActivity(i);
        } catch (Exception e) {
            Toast.makeText(app, "打不开对话界面：" + e.getClass().getSimpleName(),
                    Toast.LENGTH_SHORT).show();
        }
    }

    /** Rebuild the window with the other size mode, keeping its position. */
    private static void switchStageMode() {
        if (barShiftX != 0 && params != null) {
            params.x += barShiftX;
            barShiftX = 0;
        }
        fullStage = !fullStage;
        final String url = petUrlToLoad;
        final Context app = appCtx;
        hide();
        if (app != null && !url.isEmpty()) {
            show(app, url);
        }
    }

    /** Grow the window to the right for the action bar; never clip it. */
    private static void showActions() {
        if (root == null || params == null || manager == null
                || container == null || appCtx == null || actionBar == null) {
            return;
        }
        if (barVisible) {
            return;
        }
        barVisible = true;
        container.addView(actionBar, actionBarLayout(appCtx));

        // Keep the wider window fully on screen; remember the shift so hiding
        // the bar puts the pet back where it was.
        barShiftX = 0;
        if (!fullStage) {
            int expandedRight = params.x + winW + barW;
            int limit = screenW - dp(appCtx, 8);
            if (expandedRight > limit) {
                int shift = expandedRight - limit;
                int before = params.x;
                params.x = Math.max(dp(appCtx, 8), params.x - shift);
                barShiftX = before - params.x;
            }
        }
        syncWindowSize();
    }

    private static void hideActions() {
        if (!barVisible) {
            return;
        }
        barVisible = false;
        if (actionBar != null && actionBar.getParent() != null) {
            try {
                ((FrameLayout) actionBar.getParent()).removeView(actionBar);
            } catch (Exception ignored) { }
        }
        if (barShiftX != 0) {
            params.x += barShiftX;
            barShiftX = 0;
        }
        syncWindowSize();
    }

    /** Apply the current pet/bar sizes to the window; also commits any x change. */
    private static void syncWindowSize() {
        if (params == null || root == null || manager == null) {
            return;
        }
        int extraW = (!fullStage && barVisible) ? barW : 0;
        params.width = winW + extraW;
        params.height = Math.max(winH, barVisible ? barH : 0);
        try {
            manager.updateViewLayout(root, params);
        } catch (Exception ignored) { }
        positionBubble();
    }

    // ------------------------------------------------------ native bubble

    /** pet-app.js forwards say/ask text here as {"lines":[...]}. */
    static void showSpeech(final String json) {
        UI.post(new Runnable() {
            @Override public void run() { enqueueSpeech(json); }
        });
    }

    private static void enqueueSpeech(String json) {
        if (root == null || manager == null || appCtx == null) {
            return;                             // overlay is not running
        }
        if (screenOff) {
            return;                             // nobody can see it; the chat page keeps the history
        }
        bubbleLines.clear();
        try {
            JSONObject o = new JSONObject(json);
            JSONArray arr = o.optJSONArray("lines");
            if (arr == null) {
                return;
            }
            for (int i = 0; i < arr.length() && bubbleLines.size() < 8; i++) {
                String s = cleanSpeech(arr.optString(i, ""));
                if (!s.isEmpty()) {
                    bubbleLines.add(s);
                }
            }
        } catch (Exception ignored) {
            return;
        }
        UI.removeCallbacks(TYPE_TICK);
        UI.removeCallbacks(HOLD_TICK);
        UI.removeCallbacks(NEXT_TICK);
        removeBubble();                         // newest speech wins
        startNextLine();
    }

    /** Keep markdown link labels, drop the URLs and excess blank lines. */
    private static String cleanSpeech(String raw) {
        String s = raw.replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1");
        s = s.replaceAll("<br\\s*/?>", "\n").replaceAll("[ \\t]{2,}", " ").trim();
        return s.length() > 400 ? s.substring(0, 400) + "…" : s;
    }

    private static void startNextLine() {
        if (bubbleLines.isEmpty() || root == null) {
            return;
        }
        bubbleMessage = bubbleLines.poll();
        bubbleCursor = 0;
        ensureBubble();
        if (bubbleLabel == null || bubbleRoot == null) {
            return;
        }
        bubbleLabel.setText("");
        bubbleRoot.setAlpha(1f);
        bubbleRoot.setVisibility(View.VISIBLE);
        positionBubble();
        UI.postDelayed(TYPE_TICK, 80L);
    }

    private static void ensureBubble() {
        if (bubbleRoot != null || appCtx == null || manager == null) {
            return;
        }
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xEE152A31);
        bg.setCornerRadius(dp(appCtx, 14));
        bg.setStroke(1, 0x66BFE9DF);

        TextView label = new TextView(appCtx);
        label.setTextColor(0xFFEAFBF7);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        label.setLineSpacing(dp(appCtx, 2), 1f);
        label.setPadding(dp(appCtx, 12), dp(appCtx, 8), dp(appCtx, 12), dp(appCtx, 9));
        label.setMaxWidth(Math.min(dp(appCtx, 240), screenW - dp(appCtx, 16)));
        label.setBackground(bg);
        label.setClickable(false);
        label.setLongClickable(false);

        FrameLayout wrap = new FrameLayout(appCtx);
        wrap.setClipChildren(false);
        wrap.addView(label, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT));

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        // NOT_TOUCHABLE: taps go straight through to whatever is underneath.
        int flags = WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type, flags, PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        try {
            manager.addView(wrap, lp);
        } catch (Throwable e) {
            return;
        }
        bubbleRoot = wrap;
        bubbleLabel = label;
        bubbleParams = lp;
        UI.post(new Runnable() {
            @Override public void run() { positionBubble(); }
        });
    }

    /** Anchor the bubble just above the pet; fall below it near the top edge. */
    private static void positionBubble() {
        if (bubbleRoot == null || bubbleParams == null || params == null
                || manager == null || appCtx == null) {
            return;
        }
        int maxW = Math.min(dp(appCtx, 240), screenW - dp(appCtx, 16));
        // A fixed left edge keeps the bubble from wobbling as text grows.
        bubbleParams.x = clampI(params.x - dp(appCtx, 4), dp(appCtx, 8),
                Math.max(dp(appCtx, 8), screenW - maxW - dp(appCtx, 8)));
        int bh = bubbleRoot.getHeight();
        if (bh <= 0) {
            bh = dp(appCtx, 44);
        }
        int y = params.y - bh - dp(appCtx, 6);
        if (y < dp(appCtx, 24)) {
            int h = params.height > 0 ? params.height : winH;
            y = params.y + h + dp(appCtx, 6);
        }
        bubbleParams.y = clampI(y, dp(appCtx, 24),
                Math.max(dp(appCtx, 24), screenH - bh - dp(appCtx, 8)));
        try {
            manager.updateViewLayout(bubbleRoot, bubbleParams);
        } catch (Exception ignored) { }
    }

    /** One code point per tick, so emoji are never cut in half. */
    private static final Runnable TYPE_TICK = new Runnable() {
        @Override public void run() {
            if (bubbleRoot == null || bubbleLabel == null || bubbleMessage.isEmpty()) {
                return;
            }
            if (bubbleCursor < bubbleMessage.length()) {
                int cp = bubbleMessage.codePointAt(bubbleCursor);
                bubbleCursor += Character.charCount(cp);
                bubbleLabel.setText(bubbleMessage.substring(0, bubbleCursor));
                positionBubble();
                UI.postDelayed(this, charMs);
            } else {
                UI.postDelayed(HOLD_TICK, holdMs);
            }
        }
    };

    private static final Runnable HOLD_TICK = new Runnable() {
        @Override public void run() {
            if (bubbleRoot == null) {
                return;
            }
            bubbleRoot.animate().alpha(0f).setDuration(170L)
                    .withEndAction(new Runnable() {
                        @Override public void run() {
                            UI.postDelayed(NEXT_TICK, 40L);
                        }
                    }).start();
        }
    };

    private static final Runnable NEXT_TICK = new Runnable() {
        @Override public void run() {
            removeBubble();
            startNextLine();
        }
    };

    private static void removeBubble() {
        if (bubbleRoot != null) {
            try { bubbleRoot.animate().cancel(); } catch (Exception ignored) { }
            if (manager != null) {
                try { manager.removeViewImmediate(bubbleRoot); } catch (Exception ignored) { }
            }
        }
        bubbleRoot = null;
        bubbleLabel = null;
        bubbleParams = null;
    }

    // ------------------------------------------------------------- IME hop

    /**
     * Any keyboard detector calls this. topY is the ABSOLUTE screen y of the
     * keyboard's top edge (the same coordinate space as params.y).
     */
    public static void onImeChanged(final int source, final boolean shown, final int topY) {
        UI.post(new Runnable() {
            @Override public void run() {
                if (source < 0 || source >= imeShown.length) {
                    return;
                }
                imeShown[source] = shown;
                imeTop[source] = topY;
                imeAt[source] = SystemClock.elapsedRealtime();
                recomputeIme();
            }
        });
    }

    /** A report is only trusted while it is fresh; stale ones expire quietly. */
    private static void recomputeIme() {
        long now = SystemClock.elapsedRealtime();
        boolean up = false;
        int top = Integer.MAX_VALUE;
        for (int i = 0; i < imeShown.length; i++) {
            if (imeShown[i] && imeTop[i] > 0 && now - imeAt[i] <= IME_SOURCE_TTL) {
                up = true;
                top = Math.min(top, imeTop[i]);   // highest keyboard wins
            }
        }
        applyIme(up, up ? top : 0);
    }

    /** Move the pet above the keyboard, or spring back when it disappears. */
    private static void applyIme(boolean shown, int keyboardTop) {
        if (!imeFollow) {
            if (imeActive) {
                leaveIme(false);
            }
            return;
        }
        if (params == null || root == null || manager == null || appCtx == null) {
            return;
        }
        final int minY = minY();
        final int maxY = maxY();
        if (shown) {
            if (!imeActive) {
                imeActive = true;
                imeSavedY = params.y;
                // true = "we may move it back"; dragging clears this flag so a
                // position the user chose by hand is never overridden.
                imeRestore = true;
            }
            if (!imeRestore || keyboardTop <= 0) {
                return;
            }
            int h = params.height > 0 ? params.height : winH;
            int target = clampI(keyboardTop - h - dp(appCtx, 10), minY, maxY);
            // Do not restart the hop on every 220ms tick while it is playing.
            boolean idle = imeAnim == null || !imeAnim.isRunning();
            if (idle && params.y > target + dp(appCtx, 4)) {
                glideToY(target, true);
            }
        } else if (imeActive) {
            leaveIme(true);
        }
    }

    private static void leaveIme(boolean animate) {
        if (!imeActive) {
            return;
        }
        imeActive = false;
        if (imeRestore && imeSavedY >= 0 && params != null) {
            glideToY(clampI(imeSavedY, minY(), maxY()), animate);
        }
        imeRestore = false;
        imeSavedY = -1;
    }

    /** A short springy translate; this is the little "hop" the user asked for. */
    private static void glideToY(int target, boolean springy) {
        cancelImeAnim();
        if (params == null || root == null || manager == null || appCtx == null) {
            return;
        }
        final int minY = minY();
        final int maxY = maxY();
        target = clampI(target, minY, maxY);
        int from = params.y;
        if (Math.abs(target - from) < dp(appCtx, 3)) {
            return;
        }
        ValueAnimator anim = ValueAnimator.ofInt(from, target);
        anim.setDuration(springy ? 360L : 230L);
        anim.setInterpolator(springy
                ? new OvershootInterpolator(0.7f)
                : new DecelerateInterpolator());
        anim.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
            @Override public void onAnimationUpdate(ValueAnimator a) {
                if (params == null || root == null || manager == null) {
                    return;
                }
                int y = clampI((Integer) a.getAnimatedValue(), minY, maxY);
                if (y == params.y) {
                    return;
                }
                params.y = y;
                try {
                    manager.updateViewLayout(root, params);
                } catch (Exception ignored) { }
                positionBubble();
            }
        });
        imeAnim = anim;
        anim.start();
    }

    private static void cancelImeAnim() {
        if (imeAnim != null) {
            try { imeAnim.cancel(); } catch (Exception ignored) { }
            imeAnim = null;
        }
    }

    private static int minY() {
        return appCtx == null ? 0 : dp(appCtx, 26);
    }

    private static int maxY() {
        if (appCtx == null) {
            return screenH;
        }
        int h = (params != null && params.height > 0) ? params.height : winH;
        return Math.max(minY(), screenH - h - dp(appCtx, 8));
    }

    /**
     * Read the overlay's own visible frame. On some ROMs an overlay also gets
     * its visible area shrunk by the IME; on others this stays full-screen and
     * is simply a no-op (the other two sources cover those cases).
     */
    private static void probeSelfIme() {
        if (root == null || appCtx == null) {
            return;
        }
        try {
            root.getWindowVisibleDisplayFrame(IME_RECT);
            int bottom = IME_RECT.bottom;
            if (bottom <= 0) {
                return;
            }
            if (imeBaseline == 0 || bottom > imeBaseline) {
                imeBaseline = bottom;
            }
            int kb = imeBaseline - bottom;
            boolean shown = kb > dp(appCtx, 110) && kb < screenH * 0.62f;
            imeShown[IME_SRC_SELF] = shown;
            imeTop[IME_SRC_SELF] = shown ? bottom : 0;
            imeAt[IME_SRC_SELF] = SystemClock.elapsedRealtime();
        } catch (Throwable ignored) { }
    }

    private static final Runnable IME_TICK = new Runnable() {
        @Override public void run() {
            if (root == null) {
                imeTickRunning = false;
                return;
            }
            probeSelfIme();
            recomputeIme();
            UI.postDelayed(this, IME_TICK_MS);
        }
    };

    private static void resetImeState() {
        cancelImeAnim();
        imeActive = false;
        imeRestore = false;
        imeSavedY = -1;
        imeBaseline = 0;
        for (int i = 0; i < imeShown.length; i++) {
            imeShown[i] = false;
            imeTop[i] = 0;
            imeAt[i] = 0L;
        }
    }

    public static void setImeFollowEnabled(boolean on) {
        imeFollow = on;
        UI.post(new Runnable() {
            @Override public void run() {
                if (!imeFollow) {
                    leaveIme(false);
                } else {
                    recomputeIme();
                }
            }
        });
    }

    /**
     * Drag the window by the pet itself. A quick triple tap opens the action
     * bar; a long press and every kind of drag open nothing at all.
     */
    @SuppressLint("ClickableViewAccessibility")
    private static void attachDrag(View view, final int slop) {
        view.setOnTouchListener(new View.OnTouchListener() {
            private float startX, startY;
            private int originX, originY;
            private boolean dragging;
            private long downAt;
            private int taps;
            private long firstTapAt, lastTapAt;

            private void resetTaps() {
                taps = 0;
                firstTapAt = 0L;
                lastTapAt = 0L;
            }

            @Override public boolean onTouch(View v, MotionEvent event) {
                if (params == null || root == null || manager == null) {
                    return false;
                }
                int action = event.getActionMasked();
                if (action == MotionEvent.ACTION_DOWN) {
                    startX = event.getRawX();
                    startY = event.getRawY();
                    originX = params.x;
                    originY = params.y;
                    downAt = SystemClock.elapsedRealtime();
                    dragging = false;
                    if (barVisible) {
                        hideActions();          // tap the pet to dismiss the bar
                        resetTaps();
                    }
                    // Consume the WHOLE gesture. If the page saw this DOWN it
                    // would start a press, grab the body 6px later, and never
                    // receive an UP (MOVE/UP are ours) - leaving the figure
                    // hanging in mid-air in its "being carried" pose. Short taps
                    // are replayed to the page as synthetic pointer events.
                    return true;
                }
                if (action == MotionEvent.ACTION_MOVE) {
                    float dx = event.getRawX() - startX;
                    float dy = event.getRawY() - startY;
                    if (!dragging && Math.sqrt(dx * dx + dy * dy) > slop) {
                        dragging = true;
                        resetTaps();            // a drag is never part of a tap
                        // A hand-placed position wins: stop the hop and do not
                        // spring back when the keyboard closes.
                        cancelImeAnim();
                        imeRestore = false;
                    }
                    if (dragging) {
                        params.x = originX + (int) dx;
                        params.y = originY + (int) dy;
                        try {
                            manager.updateViewLayout(root, params);
                        } catch (Exception ignored) { }
                        positionBubble();
                        return true;
                    }
                    return false;
                }
                if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                    boolean wasDragging = dragging;
                    dragging = false;
                    if (action == MotionEvent.ACTION_CANCEL || wasDragging) {
                        resetTaps();
                        if (wasDragging) {
                            settlePet();        // stand up the moment we let go
                        }
                        return wasDragging;
                    }
                    long now = SystemClock.elapsedRealtime();
                    if (now - downAt > TAP_DOWN_MAX_MS) {
                        resetTaps();            // a press-and-hold is not a tap
                        return false;
                    }
                    if (taps == 0 || now - lastTapAt > TAP_GAP_MS
                            || now - firstTapAt > TRIPLE_TAP_WINDOW_MS) {
                        taps = 0;
                        firstTapAt = now;
                    }
                    taps++;
                    lastTapAt = now;
                    if (taps >= 3) {
                        resetTaps();
                        showActions();
                        return true;           // 3rd tap must not click the pet
                    }
                    tapPet();                  // replay tap 1/2 as a page poke
                    return true;
                }
                return false;
            }
        });
    }

    private static void setStatus(String text) {
        lastStatus = text == null ? "" : text;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private static void configure(WebView view, final String petUrl) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // The overlay is a tiny floating view: a script asking for a new tab,
        // a browser window or a JS dialog must never pop something on screen.
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);

        // Nothing in the overlay is typeable (speech is drawn by a separate
        // native window). Keeping focus away stops a hidden textarea from
        // raising the soft keyboard when the page calls input.focus().
        view.setFocusable(false);
        view.setFocusableInTouchMode(false);
        view.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        // The pet's body runs in a sandbox iframe (opaque origin = third party).
        // Blocking third-party cookies makes every script in that frame fail with 421.
        cm.setAcceptThirdPartyCookies(view, true);

        view.addJavascriptInterface(new Bridge(), "CooDiag");
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    setStatus("JS 错误: " + shorten(m.message()));
                }
                return true;
            }

            /** window.open('/dress', '_blank') and friends must not spawn a window. */
            @Override
            public boolean onCreateWindow(WebView v, boolean isDialog,
                                          boolean isUserGesture, Message resultMsg) {
                return true;
            }

            @Override
            public void onCloseWindow(WebView w) { }

            @Override
            public boolean onJsAlert(WebView v, String url, String message, JsResult result) {
                if (result != null) {
                    result.confirm();
                }
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String message, JsResult result) {
                if (result != null) {
                    result.cancel();
                }
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView v, String url, String message,
                                      String defaultValue, JsPromptResult result) {
                if (result != null) {
                    result.cancel();
                }
                return true;
            }
        });

        final String host = hostOf(petUrl);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                setStatus("页面已加载，等待宠物 …");
                inject();
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    String msg = Build.VERSION.SDK_INT >= 23
                            ? err.getErrorCode() + " " + err.getDescription() : "network error";
                    lastError = msg;
                    setStatus("页面加载失败: " + shorten(msg));
                }
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest req,
                                            android.webkit.WebResourceResponse resp) {
                if (req != null && req.isForMainFrame()) {
                    lastError = "HTTP " + resp.getStatusCode();
                    setStatus("页面被拒绝: HTTP " + resp.getStatusCode());
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                // The figure iframe and its role packs still load normally.
                if (!request.isForMainFrame()) {
                    return false;
                }
                Uri uri = request.getUrl();
                String path = uri.getPath();
                boolean sameHost = uri.getHost() != null
                        && uri.getHost().equalsIgnoreCase(host);
                // Only the pet page may navigate the overlay. /dress, /console,
                // external links and window.open targets are swallowed: this
                // window must never launch a browser or swap itself for a page.
                if (sameHost && (path == null || path.equals("/")
                        || path.startsWith("/pet"))) {
                    return false;
                }
                return true;
            }
        });
    }

    private static String shorten(String s) {
        if (s == null) {
            return "";
        }
        return s.length() > 90 ? s.substring(0, 90) : s;
    }

    /** Receives the page probe and the figure's body box from JS. */
    private static final class Bridge {
        @JavascriptInterface
        public void report(final String json) {
            UI.post(new Runnable() {
                @Override public void run() { applyDiag(json); }
            });
        }

        @JavascriptInterface
        public void box(final String json) {
            UI.post(new Runnable() {
                @Override public void run() { applyBox(json); }
            });
        }

        /** pet-app.js onOrder(): Coo's say/ask lines for the native bubble. */
        @JavascriptInterface
        public void speak(final String json) {
            showSpeech(json);
        }
    }

    private static void applyDiag(String json) {
        try {
            JSONObject o = new JSONObject(json);
            boolean gl = o.optBoolean("gl", false);
            boolean frame = o.optBoolean("frame", false);
            int loaded = o.optInt("loaded", 0);
            int ready = o.optInt("ready", 0);
            int frames = o.optInt("frames", 0);
            boolean moving = o.optBoolean("moving", false);
            String cls = o.optString("cls", "");
            if (!gl) {
                setStatus("⚠ WebView 无 WebGL，宠物画不出来");
            } else if (!frame) {
                setStatus("宠物 iframe 未创建/已被超时移除 · " + cls);
            } else if (moving) {
                setStatus("✓ 宠物在动（帧 " + frames + "）" + (seeThrough ? "（透明）" : ""));
            } else if (ready > 0 || frames > 0) {
                setStatus("宠物引擎已启动，暂时没有新帧");
            } else if (loaded > 0) {
                setStatus("iframe 脚本已加载，正在初始化 …");
            } else {
                setStatus("iframe 里脚本没运行（多半是 421 / 网络）");
            }
        } catch (Exception e) {
            setStatus("诊断数据异常");
        }
    }

    /** Fit the window to the figure's box and keep that box centred in it. */
    private static void applyBox(String json) {
        if (fullStage || web == null || root == null || params == null
                || manager == null || appCtx == null || screenOff) {
            return;
        }
        try {
            JSONObject o = new JSONObject(json);
            float x = (float) o.optDouble("x", 0);
            float y = (float) o.optDouble("y", 0);
            float w = (float) o.optDouble("w", 0);
            float h = (float) o.optDouble("h", 0);
            float vw = (float) o.optDouble("W", 0);
            float vh = (float) o.optDouble("H", 0);
            if (w < 20 || h < 20 || vw < 80 || vh < 80) {
                return;                       // still dropping in / not ready
            }
            // A hop can lift the body box above the top of the stage (y < 0).
            // Work with the part of the body still inside the viewport.
            float top = Math.max(0f, y);
            float bottom = Math.min(y + h, vh);
            float visH = Math.max(20f, bottom - top);
            float centreY = top + visH / 2f;
            float centreX = x + w / 2f;

            // CSS px and dp are 1:1 in a WebView, so dp() converts to real pixels.
            // v2.5: extra vertical room gives the hop somewhere to GO before the
            // crop has to intervene; without it she would still look frozen.
            int targetW = clampI(dp(appCtx, (int) (w + 16)),
                    dp(appCtx, 88), Math.min(dp(appCtx, 220), screenW - dp(appCtx, 16)));
            int targetH = clampI(dp(appCtx, (int) (h + JUMP_ROOM_DP)),
                    dp(appCtx, 120), Math.min(dp(appCtx, 260), screenH - dp(appCtx, 16)));

            long now = SystemClock.elapsedRealtime();
            // A jump changes the body box a lot for a few frames. Resize only
            // on a sustained change so the window itself does not pop.
            if ((Math.abs(targetW - winW) > dp(appCtx, 24)
                    || Math.abs(targetH - winH) > dp(appCtx, 24))
                    && now - lastResizeAt > 3000L) {
                winW = targetW;
                winH = targetH;
                syncWindowSize();              // keeps the action bar wide if open
                lastResizeAt = now;
            }

            float stagePxW = Math.max(stageW, vw * density);
            float stagePxH = Math.max(stageH, vh * density);
            // A positive translation is allowed: when she jumps towards the top
            // of the stage, the content must be able to slide down far enough.
            float tx = clampF(winW / 2f - centreX * density,
                    winW - stagePxW, winW / 2f);
            float centredTy = clampF(winH / 2f - centreY * density,
                    winH - stagePxH, winH / 2f);

            if (!boxReady) {
                // The pre-frame guess in show() is only an approximation. Snap
                // once to the real resting pose so the slow drift below never
                // has to walk the whole stage on the first frames.
                curTx = tx;
                curTy = centredTy;
                boxReady = true;
            }
            if (Math.abs(centreY - lastCentreY) > 1.5f) {
                lastCentreY = centreY;
                lastBoxMoveAt = now;
            }

            // Horizontal motion still follows (the body is almost as wide as
            // the window, so a dead zone there would clip her instantly).
            curTx += (tx - curTx) * 0.7f;

            if (now >= standUntil) {
                float pad = dp(appCtx, EDGE_PAD_DP);
                float bodyTop = top * density + curTy;
                float bodyBottom = bottom * density + curTy;
                if (bodyTop < pad) {
                    // Nudge only by the amount about to leave the window. The
                    // rest of the hop stays as real movement on the screen.
                    curTy = clampF(curTy + (pad - bodyTop),
                            winH - stagePxH, winH / 2f);
                } else if (bodyBottom > winH - pad) {
                    curTy = clampF(curTy - (bodyBottom - (winH - pad)),
                            winH - stagePxH, winH / 2f);
                } else if (now - lastBoxMoveAt > 350L) {
                    // Landed: drift slowly back to the centred resting pose so
                    // the next hop starts tidy. During a hop this never runs,
                    // which is exactly what makes the jump visible.
                    curTy = clampF(curTy + (centredTy - curTy) * 0.08f,
                            winH - stagePxH, winH / 2f);
                }
            }
            web.setTranslationX(curTx);
            web.setTranslationY(curTy);
        } catch (Exception ignored) { }
    }

    /** Run a tiny snippet in the pet page; harmless if the page is not ready. */
    private static void pageJs(String js) {
        if (web == null) {
            return;
        }
        try {
            web.evaluateJavascript(js, null);
        } catch (Exception ignored) { }
    }

    /** Replay a short tap, so poking the figure still gives its usual reaction. */
    private static void tapPet() {
        pageJs("window.__cooTap&&window.__cooTap()");
    }

    /**
     * Put her back on her feet the moment a drag ends. The desktop model is
     * told to stand (which also calms it for a few seconds) and its free-ground
     * line is pushed back down to the floor. The window's vertical offset is
     * frozen briefly in applyBox() so she cannot be yanked up again.
     */
    private static void settlePet() {
        standUntil = SystemClock.elapsedRealtime() + 700L;
        standTy = curTy;
        pageJs("window.__cooSettle&&window.__cooSettle()");
    }

    private static void inject() {
        if (web == null) {
            return;
        }
        try {
            web.evaluateJavascript(TRANSPARENT_JS, null);
            web.evaluateJavascript(PROBE_JS, null);
        } catch (Exception ignored) { }
    }

    private static final String TRANSPARENT_JS =
            "(function(){"
            + "if(window.__cooOverlay)return;window.__cooOverlay=1;"
            + "function fix(){"
            + "var b=document.body;if(!b)return;"
            + "if(b.classList.contains('tab')||b.classList.contains('wall')){"
            + "b.classList.remove('tab','wall');b.classList.add('desk');}"
            + "if(!document.getElementById('coo-overlay-css')){"
            + "var s=document.createElement('style');s.id='coo-overlay-css';"
            + "s.textContent='html,body{background:transparent!important;"
            + "background-color:transparent!important;background-image:none!important}'"
            + "+'.floor,.stage-mode,.wall-glow,.wall-lens,.wall-lens-grid,"
            + "#cooConsoleBtn{display:none!important}'"
            // The desktop page's own bubble is REMOVED, not merely transparent:
            // an opacity:0 textarea can still be focused by openInput(), which
            // raised the soft keyboard (and made the pet hop) on every poke.
            // The native window above draws speech instead.
            + "+'.bubble{display:none!important;visibility:hidden!important;"
            + "pointer-events:none!important}'"
            + "+'input,textarea,[contenteditable]{pointer-events:none!important}';"
            + "(document.head||document.documentElement).appendChild(s);}"
            + "}"
            + "window.__cooEngine={loaded:0,ready:0,frames:0,last:0};"
            + "window.__cooBox=null;"
            + "addEventListener('message',function(e){"
            + "var m=e&&e.data;if(!m||typeof m.t!=='string')return;"
            + "var s=window.__cooEngine;if(!s)return;"
            + "if(m.t==='loaded')s.loaded++;"
            + "else if(m.t==='ready')s.ready++;"
            + "else if(m.t==='frame'){s.frames++;s.last=Date.now();"
            + "var l=m.layout;if(l&&l.box)window.__cooBox={x:l.box.x,y:l.box.y,"
            + "w:l.box.w,h:l.box.h,W:innerWidth,H:innerHeight};}"
            + "},true);"
            + "setInterval(function(){"
            + "var b=window.__cooBox;"
            + "if(b&&b.w>8&&b.h>8&&window.CooDiag)"
            + "window.CooDiag.box(JSON.stringify(b));},120);"
            // A window drag never reaches the page any more (Java consumes the
            // whole gesture). These two helpers replay short taps and, on drag
            // release, put the body model back into a calm standing pose.
            + "window.__cooStage=function(){return document.getElementById('stage')"
            + "||document.querySelector('.stage')||document.body;};"
            + "window.__cooPoint=function(){var b=window.__cooBox;"
            + "return b?{x:b.x+b.w/2,y:b.y+b.h*0.55}:{x:innerWidth/2,y:innerHeight*0.6};};"
            + "function cooEv(t,p,b){try{return new PointerEvent(t,{bubbles:true,"
            + "cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true,"
            + "button:0,buttons:b,clientX:p.x,clientY:p.y});}catch(e){return null}}"
            // Tap straight into the figure frame: replaying a DOM pointerdown
            // would make pet-app call setPointerCapture on a synthetic id.
            + "window.__cooTap=function(){var f=document.querySelector('.figure-layer iframe');"
            + "if(!f||!f.contentWindow)return;var p=window.__cooPoint(),w=f.contentWindow;"
            + "var post=function(m){try{w.postMessage(m,'*')}catch(e){}};"
            + "var t=performance.now();"
            + "post({t:'pointer',type:'down',p:{x:p.x,y:p.y,t:t}});"
            + "post({t:'pointer',type:'up',p:{x:p.x,y:p.y,t:t+80}});};"
            + "window.__cooSettle=function(){var s=window.__cooStage(),p=window.__cooPoint();"
            + "var c=cooEv('pointercancel',p,0);if(s&&c)try{s.dispatchEvent(c)}catch(e){}"
            + "var f=document.querySelector('.figure-layer iframe');"
            + "if(!f||!f.contentWindow)return;var w=f.contentWindow;"
            + "var post=function(m){try{w.postMessage(m,'*')}catch(e){}};"
            + "post({t:'do',word:'stand'});"
            + "post({t:'place',x:p.x,facing:0,y:innerHeight});"
            + "setTimeout(function(){post({t:'do',word:'stand'});"
            + "post({t:'place',x:p.x,facing:0,y:innerHeight});},300);};"
            + "fix();setInterval(fix,2000);"
            + "})()";

    /** Reports whether the figure iframe exists and whether WebGL works here. */
    private static final String PROBE_JS =
            "(function(){"
            + "if(window.__cooProbe)return;window.__cooProbe=1;"
            + "function gl(){try{var c=document.createElement('canvas');"
            + "return !!(c.getContext('webgl2')||c.getContext('webgl'));}catch(e){return false}}"
            + "function tick(){try{"
            + "var f=document.querySelector('.figure-layer iframe');"
            + "var e=window.__cooEngine||{loaded:0,ready:0,frames:0,last:0};"
            + "var o={gl:gl(),frame:!!f,loaded:e.loaded,ready:e.ready,frames:e.frames,"
            + "moving:e.frames>0&&(Date.now()-e.last)<5000,"
            + "cls:document.body?document.body.className:'',"
            + "docReady:document.readyState,overlay:!!window.__cooOverlay};"
            + "if(window.CooDiag)window.CooDiag.report(JSON.stringify(o));"
            + "}catch(e){}}"
            + "tick();setInterval(tick,2000);"
            + "})()";

    // ------------------------------------------------ screen-off power save

    /**
     * ACTION_SCREEN_OFF. Stop everything that only exists to draw things on a
     * screen nobody is looking at. The WebSocket stays connected, so Coo's
     * words still land in the chat history and appear on wake-up.
     */
    static void onScreenOff() {
        screenOff = true;
        UI.removeCallbacks(IME_TICK);
        imeTickRunning = false;
        cancelImeAnim();
        UI.removeCallbacks(TYPE_TICK);
        UI.removeCallbacks(HOLD_TICK);
        UI.removeCallbacks(NEXT_TICK);
        bubbleLines.clear();
        bubbleMessage = "";
        bubbleCursor = 0;
        removeBubble();
        if (web != null) {
            try { web.onPause(); } catch (Throwable ignored) { }
            // Taking the view out of the composition also stops the GPU layer.
            try { web.setVisibility(View.INVISIBLE); } catch (Throwable ignored) { }
        }
    }

    /** ACTION_SCREEN_ON / ACTION_USER_PRESENT: put everything back. */
    static void onScreenOn() {
        screenOff = false;
        if (web != null) {
            try { web.setVisibility(View.VISIBLE); } catch (Throwable ignored) { }
            try { web.onResume(); } catch (Throwable ignored) { }
        }
        if (root != null && !imeTickRunning) {
            imeTickRunning = true;
            UI.postDelayed(IME_TICK, IME_TICK_MS);
        }
        // Do not let a stale "settled" timestamp drift the crop while waking.
        lastBoxMoveAt = SystemClock.elapsedRealtime();
    }

    public static void hide() {
        if (root == null) {
            return;
        }
        if (params != null) {
            savedX = params.x;
            // If the keyboard is up, remember where the pet normally lives.
            savedY = (imeActive && imeSavedY >= 0) ? imeSavedY : params.y;
        }
        UI.removeCallbacks(IME_TICK);
        imeTickRunning = false;
        cancelImeAnim();
        UI.removeCallbacks(TYPE_TICK);
        UI.removeCallbacks(HOLD_TICK);
        UI.removeCallbacks(NEXT_TICK);
        bubbleLines.clear();
        bubbleMessage = "";
        bubbleCursor = 0;
        removeBubble();
        final View view = root;
        root = null;
        try {
            if (manager != null) {
                manager.removeViewImmediate(view);
            }
        } catch (Exception ignored) { }
        if (web != null) {
            PowerSave.detach(web);
            try { web.destroy(); } catch (Exception ignored) { }
            web = null;
        }
        params = null;
        manager = null;
        container = null;
        actionBar = null;
        barVisible = false;
        barShiftX = 0;
        boxReady = false;
        resetImeState();
    }

    private static int dp(Context c, int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                c.getResources().getDisplayMetrics());
    }

    private static int clampI(int v, int lo, int hi) {
        return hi < lo ? lo : Math.max(lo, Math.min(hi, v));
    }

    private static float clampF(float v, float lo, float hi) {
        return hi < lo ? lo : Math.max(lo, Math.min(hi, v));
    }

    private static String hostOf(String url) {
        try {
            String h = Uri.parse(url).getHost();
            return h == null ? "" : h;
        } catch (Exception e) {
            return "";
        }
    }
}
