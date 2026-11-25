package coo.console;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Coo Console - a tiny native WebView shell for the Coopanion mobile console.
 *
 * The public tunnel domain changes whenever the desktop tunnel restarts, so on
 * every cold start we ask the private ntfy topic for the newest console URL.
 * That makes the APK survive tunnel restarts without being rebuilt.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "coo_console";
    private static final String KEY_URL = "console_url";

    // Private ntfy topic used by start-tunnel.py to publish fresh URLs.
    private static final String NTFY_TOPIC = "coo-YOUR_TOPIC_ID_HERE";

    // Fallback: last known good address at build time (contains the access token).
    private static final String DEFAULT_URL =
            "https://device-rug-sold-brand.trycloudflare.com/console?m=YOUR_ACCESS_TOKEN_HERE";

    private static final Pattern CONSOLE_URL = Pattern.compile(
            "https://[A-Za-z0-9._~-]+/console\\?m=[A-Za-z0-9_-]+");

    private static final int REQ_PERMISSION = 1001;

    private WebView web;
    private View overlay;
    private TextView overlayText;
    private SharedPreferences prefs;
    private volatile String currentUrl = "";
    private String currentHost = "";
    private long lastBack = 0L;
    private long lastNtfyCheck = 0L;
    private boolean errorShown = false;
    private int autoRetries = 0;
    private PermissionRequest pendingPermission;
    private int imeBaseline = 0;

    // An in-app browser layer for a World's own web windows.
    private FrameLayout worldLayer;
    private WebView worldWeb;
    private TextView worldTitle;
    private String worldUrl = "";

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // v2.5: watch SCREEN_OFF/ON for the whole process (dynamic receiver).
        PowerSave.install(getApplicationContext());

        Window win = getWindow();
        win.setStatusBarColor(Color.parseColor("#0D1A1E"));
        win.setNavigationBarColor(Color.parseColor("#0D1A1E"));

        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0D1A1E"));

        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        configureWebView();
        PowerSave.attach(web);          // keeps at least one live WebView for the global timer switch

        overlay = buildOverlay();
        root.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        TextView menuButton = buildMenuButton();
        root.addView(menuButton, menuButton.getLayoutParams());

        worldLayer = buildWorldLayer();
        root.addView(worldLayer, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
        installImeWatch();

        String saved = prefs.getString(KEY_URL, DEFAULT_URL);
        currentUrl = saved;
        currentHost = hostOf(saved);
        lastNtfyCheck = System.currentTimeMillis();
        refreshFromNtfy(true);
    }

    // ---------------------------------------------------------------- WebView

    /**
     * The app window uses adjustResize, so its visible frame shrinks when the
     * soft keyboard opens. Report the keyboard's top edge (absolute screen y)
     * to the floating pet: this covers typing inside Coo itself.
     */
    private void installImeWatch() {
        final View decor = getWindow().getDecorView();
        decor.getViewTreeObserver().addOnGlobalLayoutListener(
                new ViewTreeObserver.OnGlobalLayoutListener() {
            private final Rect r = new Rect();
            private long lastAt = 0L;
            private boolean lastShown = false;
            private int lastBottom = 0;

            @Override public void onGlobalLayout() {
                decor.getWindowVisibleDisplayFrame(r);
                if (r.bottom <= 0) {
                    return;
                }
                // Baseline = bottom of the visible area with no keyboard. It may
                // grow later (e.g. the navigation bar hides in full screen).
                if (imeBaseline == 0 || r.bottom > imeBaseline) {
                    imeBaseline = r.bottom;
                }
                int kb = imeBaseline - r.bottom;
                int screenH = getResources().getDisplayMetrics().heightPixels;
                boolean shown = kb > dp(110) && kb < screenH * 0.6f;
                boolean changed = shown != lastShown
                        || (shown && Math.abs(r.bottom - lastBottom) > dp(12));
                long now = SystemClock.elapsedRealtime();
                if (!changed && now - lastAt < 300L) {
                    return;                     // throttle identical reports
                }
                lastAt = now;
                lastShown = shown;
                lastBottom = r.bottom;
                FloatingPet.onImeChanged(FloatingPet.IME_SRC_APP, shown, r.bottom);
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        // The pet's body runs in a sandbox iframe (opaque origin = third party).
        // Blocking third-party cookies makes every script in that frame fail with 421.
        cm.setAcceptThirdPartyCookies(web, true);
        WebView.setWebContentsDebuggingEnabled(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return intercept(request.getUrl());
            }

            // Older WebView builds still route through this overload.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return intercept(Uri.parse(url));
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (url != null && url.startsWith("http")) {
                    errorShown = false;
                }
                showOverlay("正在连接 Coo …");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideOverlay();
                CookieManager.getInstance().flush();
                if (errorShown) {
                    view.clearHistory();
                    errorShown = false;
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    String detail = "";
                    try { detail = error.getDescription().toString(); } catch (Exception ignored) { }
                    showErrorPage(detail);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse errorResponse) {
                if (request.isForMainFrame() && errorResponse.getStatusCode() == 421) {
                    toast("访问凭证失效，正在重新获取地址");
                    refreshFromNtfy(false);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                List<String> missing = new ArrayList<>();
                for (String res : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                            && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                            != PackageManager.PERMISSION_GRANTED) {
                        missing.add(Manifest.permission.RECORD_AUDIO);
                    } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                            && checkSelfPermission(Manifest.permission.CAMERA)
                            != PackageManager.PERMISSION_GRANTED) {
                        missing.add(Manifest.permission.CAMERA);
                    }
                }
                if (missing.isEmpty()) {
                    runOnUiThread(new Runnable() {
                        @Override public void run() { request.grant(request.getResources()); }
                    });
                } else {
                    pendingPermission = request;
                    requestPermissions(missing.toArray(new String[0]), REQ_PERMISSION);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                try { callback.onReceiveValue(null); } catch (Exception ignored) { }
                return true;
            }
        });
    }

    /** Keep in-app navigation inside the WebView; everything else goes to a browser. */
    private boolean intercept(Uri uri) {
        String raw = uri.toString();
        if (raw.startsWith("coo://")) {
            handleAction(uri.getHost());
            return true;
        }
        if (raw.startsWith("data:") || raw.startsWith("about:")
                || raw.startsWith("javascript:")) {
            return false;
        }
        String host = uri.getHost();
        if (host != null && host.equalsIgnoreCase(currentHost)) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            toast("没有可以打开这个链接的应用");
        }
        return true;
    }

    private void handleAction(String action) {
        if ("retry".equals(action)) {
            refreshFromNtfy(false);
        } else if ("settings".equals(action)) {
            showSettings();
        } else if ("pet".equals(action)) {
            openPet();
        }
    }

    // ------------------------------------------------------------- Navigation

    private void load(final String url) {
        currentUrl = url;
        currentHost = hostOf(url);
        prefs.edit().putString(KEY_URL, url).apply();
        runOnUiThread(new Runnable() {
            @Override public void run() {
                showOverlay("正在连接 Coo …");
                web.loadUrl(url);
            }
        });
    }

    /**
     * A desktop tunnel restart changes the public domain. Cold start already
     * asks ntfy, but returning from the background must do the same - otherwise
     * the user has to force-close the app after every reconnect. This one is
     * silent: no overlay, no toast, and it only reloads when the address really
     * changed.
     */
    @Override
    protected void onResume() {
        super.onResume();
        // v2.5: reconcile the screen state even if the ROM swallowed the
        // SCREEN_ON/OFF broadcasts, BEFORE deciding whether to wake WebViews.
        PowerSave.syncInteractive(this);
        // v2.5: never wake the app's WebViews while the screen is still off.
        if (!PowerSave.isScreenOff()) {
            if (web != null) {
                web.onResume();
            }
            if (worldWeb != null) {
                worldWeb.onResume();
            }
        }
        if (web == null || prefs == null) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastNtfyCheck < 20000L) {
            return;
        }
        lastNtfyCheck = now;
        silentRefresh();
    }

    private void silentRefresh() {
        new Thread(new Runnable() {
            @Override public void run() {
                final String found = discover();
                if (found == null || found.isEmpty() || found.equals(currentUrl)) {
                    return;
                }
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (isFinishing() || isDestroyed()) {
                            return;
                        }
                        autoRetries = 0;
                        errorShown = false;
                        load(found);
                    }
                });
            }
        }, "coo-resume-discover").start();
    }

    /** Ask the private ntfy topic for the newest console URL, then load it. */
    private void refreshFromNtfy(final boolean coldStart) {
        showOverlay("正在获取最新地址 …");
        new Thread(new Runnable() {
            @Override public void run() {
                final String found = discover();
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (found != null && !found.isEmpty()) {
                            if (!found.equals(currentUrl)) {
                                load(found);
                            } else {
                                hideOverlay();
                                if (!coldStart) toast("地址已是最新");
                                else web.loadUrl(found);
                            }
                        } else {
                            if (coldStart) {
                                load(currentUrl);
                            } else {
                                hideOverlay();
                                toast("没能取到新地址，继续用当前地址");
                            }
                        }
                    }
                });
            }
        }, "coo-discover").start();
    }

    private String discover() {
        HttpURLConnection conn = null;
        try {
            URL u = new URL("https://ntfy.sh/" + NTFY_TOPIC + "/json?poll=1&since=12h");
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(6000);
            conn.setRequestProperty("User-Agent", "CooConsole/1.0");
            if (conn.getResponseCode() != 200) {
                return null;
            }
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), "UTF-8"));
            String line;
            String last = null;
            while ((line = reader.readLine()) != null) {
                Matcher m = CONSOLE_URL.matcher(line);
                while (m.find()) {
                    last = m.group();
                }
            }
            reader.close();
            return last;
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private void openPet() {
        String pet = currentUrl.replace("/console", "/pet");
        if (pet.equals(currentUrl)) {
            toast("当前地址不是控制台地址");
        } else {
            load(pet);
        }
    }

    /** The same host and token, but the pet page instead of the console. */
    private String petUrl() {
        return currentUrl.contains("/console")
                ? currentUrl.replace("/console", "/pet")
                : currentUrl;
    }

    private void toggleFloatingPet() {
        if (FloatingPet.isShowing()) {
            FloatingPet.hide();
            toast("桌面宠物已关闭");
            return;
        }
        if (!FloatingPet.canOverlay(this)) {
            FloatingPet.requestPermission(this);
            toast("请开启「显示在其他应用上层」，再回 App 点一次");
            return;
        }
        FloatingPet.toggle(getApplicationContext(), petUrl());
        if (FloatingPet.isShowing()) {
            toast("已开启：按 Home 键看桌面；拖动可移动，松手即站稳；"
                    + "连点三下出竖条，首项「×关闭」可关掉桌宠；"
                    + "Coo 说话会弹独立气泡，输入法弹起时自动跳到键盘上方");
        } else {
            String why = FloatingPet.lastError();
            toast("悬浮窗启动失败" + (why.isEmpty() ? "，请检查系统的悬浮窗权限" : "：" + why));
        }
    }

    // ------------------------------------------------------------------- UI

    private View buildOverlay() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#0D1A1E"));
        box.setClickable(true);

        TextView logo = new TextView(this);
        logo.setText("coo");
        logo.setTextColor(Color.parseColor("#EAFBF7"));
        logo.setTextSize(TypedValue.COMPLEX_UNIT_SP, 44);
        logo.setGravity(Gravity.CENTER);
        logo.setLetterSpacing(0.12f);
        box.addView(logo);

        TextView sub = new TextView(this);
        sub.setText("手机控制台");
        sub.setTextColor(Color.parseColor("#7FB9B2"));
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        subLp.topMargin = dp(6);
        box.addView(sub, subLp);

        ProgressBar bar = new ProgressBar(this, null,
                android.R.attr.progressBarStyleSmall);
        bar.setIndeterminate(true);
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        barLp.topMargin = dp(26);
        box.addView(bar, barLp);

        overlayText = new TextView(this);
        overlayText.setText("正在连接 Coo …");
        overlayText.setTextColor(Color.parseColor("#638C88"));
        overlayText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        overlayText.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams txtLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        txtLp.topMargin = dp(14);
        box.addView(overlayText, txtLp);

        return box;
    }

    private TextView buildMenuButton() {
        TextView button = new TextView(this);
        button.setText("•••");
        button.setTextColor(Color.parseColor("#DFF7F1"));
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        button.setGravity(Gravity.CENTER);

        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(Color.parseColor("#99203340"));
        bg.setStroke(1, Color.parseColor("#4DFFFFFF"));
        button.setBackground(bg);
        button.setAlpha(0.55f);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(32), dp(32));
        lp.gravity = Gravity.BOTTOM | Gravity.END;
        lp.setMargins(0, 0, dp(14), dp(22));
        button.setLayoutParams(lp);

        button.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showMenu(v); }
        });
        return button;
    }

    private void showMenu(View anchor) {
        PopupMenu popup = new PopupMenu(this, anchor);
        popup.getMenu().add(0, 1, 0, "刷新页面");
        popup.getMenu().add(0, 2, 1, "获取最新地址");
        popup.getMenu().add(0, 3, 2, "打开桌宠");
        popup.getMenu().add(0, 4, 3, "设置服务器地址");
        popup.getMenu().add(0, 5, 4, "复制当前地址");
        popup.getMenu().add(0, 6, 5, "用浏览器打开");
        popup.getMenu().add(0, 7, 6, FloatingPet.isShowing()
                ? "关闭桌面悬浮宠物" : "开启桌面悬浮宠物");
        popup.getMenu().add(0, 8, 7, FloatingPet.isSeeThrough()
                ? "悬浮窗：切到可见背景" : "悬浮窗：切到透明背景");
        popup.getMenu().add(0, 9, 8, "桌宠没显示？自查步骤");
        popup.getMenu().add(0, 10, 9, "悬浮窗运行状态");
        popup.getMenu().add(0, 11, 10, FloatingPet.isFullStage()
                ? "悬浮窗尺寸：改为贴合宠物" : "悬浮窗尺寸：改为完整舞台（大框）");
        popup.getMenu().add(0, 12, 11, isAccessibilityOn()
                ? "键盘跟随：全局已开启（查看说明）"
                : "键盘跟随：开启全局跟随（设置一次）");
        popup.getMenu().add(0, 13, 12, FloatingPet.isImeFollowEnabled()
                ? "键盘跟随：暂时关闭" : "键盘跟随：重新开启");
        popup.getMenu().add(0, 14, 13, "对话气泡：生成速度与停留时间");
        popup.getMenu().add(0, 15, 14, "World 网页窗口（打开各 World 的页面）");
        popup.getMenu().add(0, 16, 15, "和 Coo 说话（对话界面）");
        popup.setOnMenuItemClickListener(new PopupMenu.OnMenuItemClickListener() {
            @Override public boolean onMenuItemClick(android.view.MenuItem item) {
                switch (item.getItemId()) {
                    case 1: web.reload(); break;
                    case 2: refreshFromNtfy(false); break;
                    case 3: openPet(); break;
                    case 4: showSettings(); break;
                    case 5: copyUrl(); break;
                    case 6:
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(currentUrl)));
                        } catch (Exception e) {
                            toast("没有可以打开链接的应用");
                        }
                        break;
                    case 7:
                        toggleFloatingPet();
                        break;
                    case 8:
                        FloatingPet.toggleBackground();
                        toast(FloatingPet.isSeeThrough()
                                ? "悬浮窗已透明" : "悬浮窗已改为可见背景");
                        break;
                    case 9:
                        showPetHelp();
                        break;
                    case 10:
                        toast(FloatingPet.isShowing()
                                ? FloatingPet.lastStatus() + keyboardLine()
                                : "悬浮窗没开着；点「开启桌面悬浮宠物」后再看");
                        break;
                    case 11:
                        boolean compact = FloatingPet.isFullStage();
                        FloatingPet.setFullStage(!compact);
                        if (FloatingPet.isShowing()) {
                            FloatingPet.hide();
                        }
                        toast(compact
                                ? "已改为贴合宠物大小，重新开启悬浮窗生效"
                                : "已改为完整舞台大框，重新开启悬浮窗生效");
                        break;
                    case 12:
                        showKeyboardGuide();
                        break;
                    case 13:
                        boolean next = !FloatingPet.isImeFollowEnabled();
                        FloatingPet.setImeFollowEnabled(next);
                        toast(next ? "键盘跟随已开启" : "键盘跟随已关闭，桌宠保持当前位置");
                        break;
                    case 14:
                        showBubbleSettings();
                        break;
                    case 15:
                        showWorldWindows();
                        break;
                    case 16:
                        startActivity(new Intent(MainActivity.this, ChatActivity.class)
                                .putExtra("chat_host", currentHost)
                                .putExtra("chat_token", token()));
                        break;
                }
                return true;
            }
        });
        popup.show();
    }

    private String keyboardLine() {
        if (!FloatingPet.isImeFollowEnabled()) {
            return "\n键盘跟随：已关闭";
        }
        if (FloatingPet.isImeActive()) {
            return "\n键盘跟随：键盘已弹起，桌宠已跳到上方";
        }
        return "\n键盘跟随：" + (isAccessibilityOn()
                ? "待命（全局已开启）"
                : "待命（App 内可用，跨 App 需开启全局跟随）");
    }

    private boolean isAccessibilityOn() {
        try {
            String list = Settings.Secure.getString(getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            return list != null
                    && list.toLowerCase().contains(getPackageName().toLowerCase());
        } catch (Exception e) {
            return false;
        }
    }

    private void openAccessibilitySettings() {
        try {
            Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            toast("打不开系统设置，请手动到「设置 → 无障碍」里开启");
        }
    }

    private void showKeyboardGuide() {
        if (isAccessibilityOn()) {
            new AlertDialog.Builder(this)
                    .setTitle("键盘跟随已开启")
                    .setMessage("在任意 App 里唤起输入法，桌宠都会自动跳到键盘上方；"
                            + "收起键盘后弹回原位。\n\n"
                            + "想彻底关掉，请到系统「无障碍」里关闭「Coo 桌宠键盘跟随」；"
                            + "只想临时关一下，用菜单里「键盘跟随：暂时关闭」。")
                    .setPositiveButton("知道了", null)
                    .setNeutralButton("去系统设置", new android.content.DialogInterface.OnClickListener() {
                        @Override public void onClick(android.content.DialogInterface d, int w) {
                            openAccessibilitySettings();
                        }
                    })
                    .show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("开启全局键盘跟随")
                .setMessage("在 Coo 里打字时，桌宠已经会自动跳到键盘上方。\n\n"
                        + "要在微信、浏览器等别的 App 里打字时也自动跟随，"
                        + "Android 需要一次授权：\n\n"
                        + "① 点「去设置」\n"
                        + "② 找到「Coo 桌宠键盘跟随」并打开\n"
                        + "③ 回到桌面，随便唤起一次输入法试试\n\n"
                        + "该服务只读取输入法窗口的位置与高度，"
                        + "不读取屏幕文字、不联网、不上传任何内容。")
                .setPositiveButton("去设置", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) {
                        openAccessibilitySettings();
                    }
                })
                .setNegativeButton("暂不", null)
                .show();
    }

    // ------------------------------------------------------ World web windows

    /** The phone token carried by the current console address. */
    private String token() {
        try {
            String v = Uri.parse(currentUrl).getQueryParameter("m");
            return v == null ? "" : v;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * A World declares its web windows as http://127.0.0.1:7797/... links for
     * the desktop. On a phone those point at the phone itself: rewrite them to
     * the public host we actually use and attach the access token. Links to a
     * genuinely external site are returned untouched for the system browser.
     */
    private String normalizeLink(String href) {
        if (href == null) {
            return null;
        }
        String h = href.trim();
        if (!h.startsWith("http://") && !h.startsWith("https://")
                && !h.startsWith("/")) {
            return null;                        // javascript:, file:, data: ...
        }
        try {
            Uri u = Uri.parse(h);
            String host = u.getHost();
            if (host != null && !host.equalsIgnoreCase(currentHost)
                    && !host.equals("127.0.0.1") && !host.equals("localhost")
                    && !host.equals("::1")) {
                return h;
            }
            String path = u.getEncodedPath();
            if (path == null || path.isEmpty()) {
                path = "/";
            }
            String query = u.getEncodedQuery();
            String m = token();
            StringBuilder sb = new StringBuilder("https://")
                    .append(currentHost).append(path);
            if (!m.isEmpty()) {
                sb.append("?m=").append(m);
            }
            if (query != null && !query.isEmpty()) {
                sb.append(m.isEmpty() ? "?" : "&").append(query);
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    /** The console page, opened on one World's card and its settings. */
    private String worldPageUrl(String id) {
        return "https://" + currentHost + "/console?m=" + token()
                + "&world=" + Uri.encode(id);
    }

    private String httpGet(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("User-Agent", "CooConsole/2.0");
            if (conn.getResponseCode() != 200) {
                return "";
            }
            BufferedReader r = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line);
            }
            r.close();
            return sb.toString();
        } catch (Exception e) {
            return "";
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private void showWorldWindows() {
        final String url = "https://" + currentHost + "/api/m/worlds?m=" + token();
        toast("正在读取 World 列表 …");
        new Thread(new Runnable() {
            @Override public void run() {
                final String body = httpGet(url);
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        showWorldList(body);
                    }
                });
            }
        }, "coo-worlds").start();
    }

    private TextView linkButton(String text) {
        TextView b = new TextView(this);
        b.setText(text);
        b.setTextColor(Color.parseColor("#DFF7F1"));
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        b.setPadding(dp(12), dp(9), dp(12), dp(9));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#1B333A"));
        bg.setCornerRadius(dp(9));
        b.setBackground(bg);
        b.setClickable(true);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(4);
        b.setLayoutParams(lp);
        return b;
    }

    private void showWorldList(String body) {
        JSONArray worlds = null;
        try {
            worlds = new JSONObject(body).optJSONArray("worlds");
        } catch (Exception ignored) { }
        if (worlds == null || worlds.length() == 0) {
            toast("没取到 World 列表，先点「获取最新地址」再试");
            return;
        }

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(8), dp(18), dp(8));

        TextView hintTop = new TextView(this);
        hintTop.setText("点任一项在 App 里打开，左上角 ← 返回；外部网址交给浏览器。");
        hintTop.setTextColor(Color.parseColor("#8FB4B0"));
        hintTop.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hintTop.setPadding(0, dp(4), 0, dp(8));
        box.addView(hintTop);

        for (int i = 0; i < worlds.length(); i++) {
            JSONObject w = worlds.optJSONObject(i);
            if (w == null) {
                continue;
            }
            final String id = w.optString("id", "");
            final String label = w.optString("label", id);
            String status = w.optString("status", "");

            TextView head = new TextView(this);
            head.setText(label + "  ·  " + id + "  ·  " + status);
            head.setTextColor(Color.parseColor("#7FB9B2"));
            head.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            head.setPadding(0, dp(12), 0, dp(2));
            box.addView(head);

            JSONArray links = w.optJSONArray("links");
            int found = 0;
            if (links != null) {
                for (int j = 0; j < links.length(); j++) {
                    JSONObject l = links.optJSONObject(j);
                    if (l == null) {
                        continue;
                    }
                    final String target = normalizeLink(l.optString("href", ""));
                    if (target == null) {
                        continue;
                    }
                    final String name = l.optString("label", "打开网页窗口");
                    found++;
                    TextView b = linkButton("  ▸ " + name);
                    b.setOnClickListener(new View.OnClickListener() {
                        @Override public void onClick(View v) {
                            openWorldWindow(target, name);
                        }
                    });
                    box.addView(b);
                }
            }
            if (found == 0) {
                TextView none = new TextView(this);
                none.setText("  （这个 World 没声明独立网页窗口）");
                none.setTextColor(Color.parseColor("#5F8883"));
                none.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
                none.setPadding(dp(12), dp(4), 0, dp(2));
                box.addView(none);
            }
            final String page = worldPageUrl(id);
            TextView own = linkButton("  ▸ 「" + label + "」的设置与状态页");
            own.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    openWorldWindow(page, label);
                }
            });
            box.addView(own);
        }

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        new AlertDialog.Builder(this)
                .setTitle("World 网页窗口")
                .setView(scroll)
                .setNegativeButton("关闭", null)
                .show();
    }

    private void openWorldWindow(String url, String title) {
        if (url == null || url.isEmpty()) {
            toast("这个链接打不开");
            return;
        }
        if (!url.startsWith("https://" + currentHost)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception e) {
                toast("没有能打开这个链接的应用");
            }
            return;
        }
        worldUrl = url;
        worldTitle.setText(title);
        worldLayer.setVisibility(View.VISIBLE);
        worldLayer.bringToFront();
        worldWeb.loadUrl(url);
    }

    private void closeWorldWindow() {
        worldLayer.setVisibility(View.GONE);
        worldWeb.loadUrl("about:blank");
        worldUrl = "";
    }

    private boolean worldIntercept(Uri u) {
        String host = u.getHost();
        if (host != null && host.equalsIgnoreCase(currentHost)) {
            return false;
        }
        String raw = u.toString();
        if (raw.startsWith("data:") || raw.startsWith("about:")
                || raw.startsWith("javascript:")) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception e) {
            toast("没有能打开这个链接的应用");
        }
        return true;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private FrameLayout buildWorldLayer() {
        FrameLayout layer = new FrameLayout(this);
        layer.setBackgroundColor(Color.parseColor("#0D1A1E"));
        layer.setVisibility(View.GONE);
        layer.setClickable(true);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        layer.addView(col, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(Color.parseColor("#14262C"));
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(6), dp(6), dp(6));
        col.addView(bar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(46)));

        TextView back = new TextView(this);
        back.setText("←");
        back.setTextColor(Color.parseColor("#EAFBF7"));
        back.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        back.setGravity(Gravity.CENTER);
        back.setLayoutParams(new LinearLayout.LayoutParams(dp(40),
                LinearLayout.LayoutParams.MATCH_PARENT));
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { closeWorldWindow(); }
        });
        bar.addView(back);

        worldTitle = new TextView(this);
        worldTitle.setTextColor(Color.parseColor("#EAFBF7"));
        worldTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        worldTitle.setSingleLine(true);
        worldTitle.setGravity(Gravity.CENTER_VERTICAL);
        worldTitle.setPadding(dp(6), 0, dp(6), 0);
        bar.addView(worldTitle, new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.MATCH_PARENT, 1f));

        TextView reload = new TextView(this);
        reload.setText("⟳");
        reload.setTextColor(Color.parseColor("#EAFBF7"));
        reload.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        reload.setGravity(Gravity.CENTER);
        reload.setLayoutParams(new LinearLayout.LayoutParams(dp(38),
                LinearLayout.LayoutParams.MATCH_PARENT));
        reload.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { worldWeb.reload(); }
        });
        bar.addView(reload);

        TextView external = new TextView(this);
        external.setText("↗");
        external.setTextColor(Color.parseColor("#EAFBF7"));
        external.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        external.setGravity(Gravity.CENTER);
        external.setLayoutParams(new LinearLayout.LayoutParams(dp(38),
                LinearLayout.LayoutParams.MATCH_PARENT));
        external.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (worldUrl.isEmpty()) {
                    return;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(worldUrl)));
                } catch (Exception e) {
                    toast("没有能打开这个链接的应用");
                }
            }
        });
        bar.addView(external);

        worldWeb = new WebView(this);
        PowerSave.attach(worldWeb);
        WebSettings s = worldWeb.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSaveFormData(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(worldWeb, true);
        worldWeb.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return worldIntercept(r.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return worldIntercept(Uri.parse(url));
            }
            @Override public void onPageFinished(final WebView v, String url) {
                if (url == null || !url.contains("world=")) {
                    return;
                }
                final String id = Uri.parse(url).getQueryParameter("world");
                if (id == null || id.isEmpty()) {
                    return;
                }
                // Focus the requested World's card once the console has drawn it.
                final String js = "(function(){var c=document.querySelector('[data-id=\"'+"
                        + JSONObject.quote(id) + "+'\"]');"
                        + "if(!c)return;c.scrollIntoView({block:'center'});"
                        + "var d=c.querySelector('[data-act=\"detail\"]');"
                        + "if(d)d.click();})()";
                v.postDelayed(new Runnable() {
                    @Override public void run() {
                        try {
                            v.evaluateJavascript(js, null);
                        } catch (Exception ignored) { }
                    }
                }, 800L);
            }
        });
        col.addView(worldWeb, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        return layer;
    }

    private void showBubbleSettings() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(22), dp(6), dp(22), 0);

        TextView hint = new TextView(this);
        hint.setText("Coo 说话时，气泡在宠物上方独立弹出：文字一个一个生成，"
                + "生成完停留后自动消失，气泡不接收触摸。\n"
                + "整段生成时间 ≈ 字数 × 每字间隔。");
        hint.setTextColor(Color.parseColor("#8FB4B0"));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hint.setLineSpacing(dp(3), 1f);
        box.addView(hint);

        final EditText charInput = new EditText(this);
        charInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        charInput.setSingleLine(true);
        charInput.setHint("每字生成间隔（毫秒，10~1000）");
        charInput.setText(String.valueOf(FloatingPet.charMillis(this)));
        box.addView(charInput);

        final EditText holdInput = new EditText(this);
        holdInput.setInputType(InputType.TYPE_CLASS_NUMBER
                | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        holdInput.setSingleLine(true);
        holdInput.setHint("生成完停留（秒，0~10，默认 0.3）");
        holdInput.setText(String.valueOf(FloatingPet.holdMillis(this) / 1000f));
        box.addView(holdInput);

        new AlertDialog.Builder(this)
                .setTitle("对话气泡设置")
                .setView(box)
                .setPositiveButton("保存", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) {
                        long perChar;
                        double seconds;
                        try {
                            perChar = Long.parseLong(charInput.getText().toString().trim());
                            seconds = Double.parseDouble(holdInput.getText().toString().trim());
                        } catch (Exception e) {
                            toast("两栏都要填数字");
                            return;
                        }
                        long hold = Math.round(seconds * 1000);
                        perChar = Math.max(10L, Math.min(1000L, perChar));
                        hold = Math.max(0L, Math.min(10000L, hold));
                        FloatingPet.setTimings(MainActivity.this, perChar, hold);
                        toast("已保存：每字 " + perChar + "ms，停留 "
                                + (hold / 1000f) + " 秒（立即生效）");
                    }
                })
                .setNeutralButton("试一条", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) {
                        if (FloatingPet.isShowing()) {
                            FloatingPet.testBubble();
                            toast("已弹出一条测试气泡");
                        } else {
                            toast("请先开启桌面悬浮宠物");
                        }
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void showPetHelp() {
        new AlertDialog.Builder(this)
                .setTitle("桌宠没显示？按顺序自查")
                .setMessage(
                        "1. 先点菜单「打开桌宠」，看主界面里宠物有没有出现。\n"
                        + "   主界面也没有 → 是页面渲染/WebGL 兼容问题，与悬浮窗无关。\n"
                        + "   可去应用商店把「Android System WebView」和 Chrome 更新到最新。\n\n"
                        + "2. 主界面有、悬浮窗没有 → 快速连点三下桌宠，在右侧竖条里点「状态」，"
                        + "或点菜单「悬浮窗运行状态」：\n"
                        + "   · 「页面加载失败 / HTTP 421」→ 地址或凭证失效，点「获取最新地址」\n"
                        + "   · 「iframe 未创建 / 脚本没运行」→ 网络或 WebSocket 没通，切回 WiFi/4G 再试\n"
                        + "   · 「无 WebGL」→ 更新系统 WebView\n\n"
                        + "3. 快速连点三下桌宠才会出现右侧竖条：首项「×关闭」就是原来的右上角关闭按钮，"
                        + "下面依次是 刷新 / 背景 / 状态 / 尺寸 / 收起。\n"
                        + "   桌宠右上角已经没有 × 了，也可以回 App 菜单点「关闭桌面悬浮宠物」。\n"
                        + "   拖动桌宠、长按都不会弹出任何菜单；点一下宠物或点「收起」可收起竖条。\n\n"
                        + "4. 小窗默认只有宠物大小，直接按住宠物拖动即可移动，松手她会立刻站稳在原地、"
                        + "不会被电脑端模型吊在半空；拖动时网页不再接收这次触摸。\n"
                        + "   小米 / OPPO / vivo 等还需在系统设置里手动放行「显示在其他应用上层」和后台弹窗。\n\n"
                        + "5. 唤起输入法时桌宠会自动跳到键盘上方，收起后弹回原位；"
                        + "在别的 App 里打字也要跟随的话，点菜单「键盘跟随：开启全局跟随」按提示开一次即可。\n\n"
                        + "6. Coo 说话会在宠物上方弹出独立气泡：逐字生成、停留后消失、气泡不挡触摸；"
                        + "在菜单「对话气泡：生成速度与停留时间」里可调每字间隔和停留时长，还能试弹一条。"
                        + "带选项的问答题仍需回到 App 页面里操作。\n\n"
                        + "7. 菜单「World 网页窗口」会列出每个 World 声明的网页窗口（如桌宠的查看/装扮页），"
                        + "点开后在 App 内打开、左上角 ← 返回；没声明窗口的 World 也能打开它自己的设置与状态页。")
                .setPositiveButton("知道了", null)
                .show();
    }

    private void copyUrl() {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) {
            cm.setPrimaryClip(ClipData.newPlainText("Coo URL", currentUrl));
            toast("地址已复制（含访问凭证，请勿外传）");
        }
    }

    private void showSettings() {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("服务器地址");
        final EditText input = new EditText(this);
        input.setText(prefs.getString(KEY_URL, DEFAULT_URL));
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setSelection(input.getText().length());
        int pad = dp(20);
        input.setPadding(pad, dp(10), pad, dp(10));
        builder.setView(input);
        builder.setMessage("粘贴 ntfy 通知里的「控制台」完整链接（https 开头，含 ?m= 凭证）。");
        builder.setPositiveButton("保存并打开", new android.content.DialogInterface.OnClickListener() {
            @Override public void onClick(android.content.DialogInterface d, int w) {
                String url = input.getText().toString().trim();
                if (!url.startsWith("https://")) {
                    toast("需要 https:// 开头的完整链接");
                    return;
                }
                load(url);
            }
        });
        builder.setNeutralButton("从 ntfy 重取", new android.content.DialogInterface.OnClickListener() {
            @Override public void onClick(android.content.DialogInterface d, int w) {
                refreshFromNtfy(false);
            }
        });
        builder.setNegativeButton("取消", null);
        builder.show();
    }

    private void showErrorPage(String detail) {
        String safe = detail.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
        String html = "<!doctype html><html><head><meta name=\"viewport\" "
                + "content=\"width=device-width,initial-scale=1\">"
                + "<meta name=\"color-scheme\" content=\"dark\">"
                + "<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;"
                + "background:#0D1A1E;color:#EAFBF7;font-family:system-ui,-apple-system,sans-serif;"
                + "display:flex;align-items:center;justify-content:center;padding:28px}"
                + ".card{width:100%;max-width:420px;text-align:center}"
                + ".mark{font-size:46px;font-weight:600;letter-spacing:.1em}"
                + "h1{font-size:19px;font-weight:600;margin:18px 0 8px}"
                + "p{font-size:13px;line-height:1.7;color:#8FB4B0;margin:0 0 22px}"
                + "a{display:block;text-decoration:none;padding:13px;border-radius:13px;"
                + "font-size:14px;font-weight:600;margin-bottom:10px}"
                + ".primary{background:#28B49C;color:#04201C}"
                + ".ghost{background:#172B31;color:#CDEAE4;border:1px solid #2B4750}"
                + ".tip{font-size:11px;color:#5F8883;margin-top:18px;line-height:1.6}"
                + "</style></head><body><div class=\"card\">"
                + "<div class=\"mark\">coo</div>"
                + "<h1>连不上家里的电脑</h1>"
                + "<p>可能是电脑关机、休眠或隧道刚换地址。<br>"
                + (safe.isEmpty() ? "" : "错误：" + safe + "<br>")
                + "新地址会由 ntfy 自动推送，点下面的按钮重取一次即可。</p>"
                + "<a class=\"primary\" href=\"coo://retry\">重新获取最新地址</a>"
                + "<a class=\"ghost\" href=\"coo://settings\">手动填写地址</a>"
                + "<a class=\"ghost\" href=\"coo://pet\">直接打开桌宠</a>"
                + "<div class=\"tip\">电脑需要保持开机并运行 Coopanion 与隧道管理器。</div>"
                + "</div></body></html>";
        errorShown = true;
        hideOverlay();
        web.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);

        // A tunnel restart changes the public domain. Retry the ntfy lookup once
        // automatically so the user does not have to tap anything after a restart.
        if (autoRetries < 1) {
            autoRetries++;
            web.postDelayed(new Runnable() {
                @Override public void run() {
                    if (!isFinishing() && !isDestroyed() && errorShown) {
                        refreshFromNtfy(false);
                    }
                }
            }, 1500L);
        }
    }

    private void showOverlay(String text) {
        if (overlayText != null) {
            overlayText.setText(text);
        }
        if (overlay != null) {
            overlay.setVisibility(View.VISIBLE);
            overlay.bringToFront();
        }
    }

    private void hideOverlay() {
        if (overlay != null) {
            overlay.setVisibility(View.GONE);
        }
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics());
    }

    private static String hostOf(String url) {
        try {
            String h = Uri.parse(url).getHost();
            return h == null ? "" : h;
        } catch (Exception e) {
            return "";
        }
    }

    // ------------------------------------------------------------- Lifecycle

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMISSION && pendingPermission != null) {
            boolean ok = grantResults.length > 0;
            for (int r : grantResults) {
                if (r != PackageManager.PERMISSION_GRANTED) {
                    ok = false;
                }
            }
            if (ok) {
                pendingPermission.grant(pendingPermission.getResources());
            } else {
                pendingPermission.deny();
                toast("需要麦克风/相机权限才能使用语音");
            }
            pendingPermission = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (worldLayer != null && worldLayer.getVisibility() == View.VISIBLE) {
            closeWorldWindow();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000L) {
            super.onBackPressed();
            return;
        }
        lastBack = now;
        toast("再按一次退出 Coo");
    }

    @Override
    protected void onPause() {
        super.onPause();
        // v2.5: stop the console/world pages from drawing while in background.
        if (web != null) {
            web.onPause();
        }
        if (worldWeb != null) {
            worldWeb.onPause();
        }
        CookieManager.getInstance().flush();
        // NB: no syncInteractive() here - during the power-key transition
        // isInteractive() can still read true and would cancel a SCREEN_OFF.
    }

    @Override
    protected void onDestroy() {
        PowerSave.detach(worldWeb);
        PowerSave.detach(web);
        if (worldWeb != null) {
            worldWeb.destroy();
        }
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }
}
