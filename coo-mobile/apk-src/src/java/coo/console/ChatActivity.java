package coo.console;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * A native conversation page for the phone. It talks only to the pet
 * service's two narrow chat endpoints, so it never competes with the floating
 * pet for the single live `role=pet` socket:
 *
 *   GET  /api/m/chat/events  - recent lines, then cursor-based polling
 *   POST /api/m/chat/send    - deliver one typed line to the World
 *
 * Everything is built in code: this APK is compiled without Gradle/androidx.
 */
public class ChatActivity extends Activity {

    private static final String PREFS = "coo_console";
    private static final String KEY_URL = "console_url";
    private static final String DEFAULT_URL =
            "https://points-rarely-innocent-responses.trycloudflare.com/console?m=YOUR_ACCESS_TOKEN_HERE";
    private static final int POLL_MS = 2500;
    private static final int PAGE = 60;

    private String host = "";
    private String token = "";

    private LinearLayout box;
    private ScrollView scroll;
    private EditText input;
    private TextView status;
    private Button sendButton;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final List<Line> lines = new ArrayList<>();
    private final Set<Long> seen = new HashSet<>();
    private long after = 0L;
    private boolean loading = false;
    private boolean firstLoad = true;
    private boolean alive = false;
    private int maxBubble = 0;

    private static final class Line {
        long cursor;
        String role;
        String text;
        String ts;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#0D1A1E"));
        getWindow().setNavigationBarColor(Color.parseColor("#0D1A1E"));

        Intent i = getIntent();
        host = i == null ? "" : nullToEmpty(i.getStringExtra("chat_host"));
        token = i == null ? "" : nullToEmpty(i.getStringExtra("chat_token"));
        if (host.isEmpty() || token.isEmpty()) {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            String saved = p.getString(KEY_URL, DEFAULT_URL);
            try {
                Uri u = Uri.parse(saved);
                host = nullToEmpty(u.getHost());
                token = nullToEmpty(u.getQueryParameter("m"));
            } catch (Exception ignored) {
                // keep the (possibly empty) values; the status line will say so
            }
        }
        maxBubble = (int) (getResources().getDisplayMetrics().widthPixels * 0.78f);
        buildUi();
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    // ------------------------------------------------------------------- UI

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0D1A1E"));
        root.setPadding(dp(10), dp(8), dp(10), dp(10));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        Button back = new Button(this);
        back.setText("\u2039 返回");
        back.setTextColor(Color.WHITE);
        back.setTextSize(14f);
        back.setBackgroundColor(Color.TRANSPARENT);
        back.setPadding(dp(4), 0, dp(10), 0);
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        top.addView(back, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("和 Coo 说话");
        title.setTextColor(Color.WHITE);
        title.setTextSize(18f);
        top.addView(title, new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        Button refresh = new Button(this);
        refresh.setText("刷新");
        refresh.setTextColor(Color.parseColor("#8FD8C4"));
        refresh.setTextSize(13f);
        refresh.setBackgroundColor(Color.TRANSPARENT);
        refresh.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                status.setText("正在刷新…");
                poll();
            }
        });
        top.addView(refresh, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(top, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        status = new TextView(this);
        status.setText(host.isEmpty() ? "没有服务器地址，回主界面点「获取最新地址」" : "正在读取对话…");
        status.setTextColor(Color.parseColor("#7FA39E"));
        status.setTextSize(11f);
        status.setPadding(dp(4), dp(2), dp(4), dp(8));
        root.addView(status, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(2), dp(4), dp(2), dp(6));
        scroll.addView(box, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(0, dp(8), 0, 0);

        GradientDrawable inputBg = new GradientDrawable();
        inputBg.setColor(Color.parseColor("#17313A"));
        inputBg.setCornerRadius(dp(14));
        input = new EditText(this);
        input.setBackground(inputBg);
        input.setHint("说点什么…");
        input.setHintTextColor(Color.parseColor("#7FA39E"));
        input.setTextColor(Color.WHITE);
        input.setTextSize(15f);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        input.setMaxLines(4);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        bar.addView(input, new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        GradientDrawable sendBg = new GradientDrawable();
        sendBg.setColor(Color.parseColor("#1F8A70"));
        sendBg.setCornerRadius(dp(14));
        sendButton = new Button(this);
        sendButton.setText("发送");
        sendButton.setTextColor(Color.WHITE);
        sendButton.setTextSize(14f);
        sendButton.setBackground(sendBg);
        sendButton.setPadding(dp(14), 0, dp(14), 0);
        LinearLayout.LayoutParams sendLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(44));
        sendLp.leftMargin = dp(8);
        bar.addView(sendButton, sendLp);
        sendButton.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { sendLine(); }
        });
        root.addView(bar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }

    private void addLine(Line l) {
        final boolean me = "me".equals(l.role);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setGravity(me ? Gravity.RIGHT : Gravity.LEFT);
        row.setPadding(0, dp(5), 0, dp(5));

        String when = timeOf(l.ts);
        TextView label = new TextView(this);
        label.setText((me ? "我" : "Coo") + (when.isEmpty() ? "" : "  " + when));
        label.setTextColor(Color.parseColor("#7FA39E"));
        label.setTextSize(11f);
        label.setGravity(me ? Gravity.RIGHT : Gravity.LEFT);
        row.addView(label, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(me ? "#1F6F5C" : "#17313A"));
        bg.setCornerRadius(dp(14));
        TextView tv = new TextView(this);
        tv.setText(l.text);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(15f);
        tv.setPadding(dp(12), dp(9), dp(12), dp(9));
        tv.setBackground(bg);
        tv.setMaxWidth(maxBubble);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.gravity = me ? Gravity.RIGHT : Gravity.LEFT;
        lp.topMargin = dp(3);
        row.addView(tv, lp);

        box.addView(row, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
    }

    private static String timeOf(String ts) {
        return ts != null && ts.length() >= 16 && ts.charAt(10) == 'T'
                ? ts.substring(11, 16) : "";
    }

    private void scrollToEnd() {
        scroll.post(new Runnable() {
            @Override public void run() { scroll.fullScroll(View.FOCUS_DOWN); }
        });
    }

    // -------------------------------------------------------------- lifecycle

    private final Runnable poller = new Runnable() {
        @Override public void run() {
            if (!alive) return;
            // v2.5: no network polling while the screen is off. Keep a very
            // slow heartbeat so the loop restarts by itself on wake-up even on
            // phones that do not call onPause() when the power key is pressed.
            final boolean asleep = PowerSave.isScreenOff();
            if (!asleep) poll();
            ui.postDelayed(this, asleep ? 15000 : POLL_MS);
        }
    };

    @Override protected void onResume() {
        super.onResume();
        alive = true;
        poll();
        ui.removeCallbacks(poller);
        ui.postDelayed(poller, POLL_MS);
    }

    @Override protected void onPause() {
        super.onPause();
        alive = false;
        ui.removeCallbacks(poller);
    }

    // ------------------------------------------------------------------ data

    private String api(String path) {
        return "https://" + host + path
                + (path.indexOf('?') >= 0 ? "&m=" : "?m=") + token;
    }

    private void poll() {
        if (loading || host.isEmpty() || token.isEmpty()
                || PowerSave.isScreenOff()) return;
        loading = true;
        final String path = "/api/m/chat/events?limit=" + PAGE
                + (after > 0 ? "&after=" + after : "");
        final String url = api(path);
        new Thread(new Runnable() {
            @Override public void run() {
                final String body = httpGet(url);
                ui.post(new Runnable() {
                    @Override public void run() {
                        loading = false;
                        apply(body);
                    }
                });
            }
        }).start();
    }

    private void apply(String body) {
        if (body == null || body.isEmpty()) {
            status.setText("连不上 Coo · 回主界面点「获取最新地址」");
            return;
        }
        try {
            JSONObject o = new JSONObject(body);
            if (!o.optBoolean("ok", false)) {
                status.setText("服务端暂时没回应，稍后重试");
                return;
            }
            long next = o.optLong("next", 0L);
            JSONArray items = o.optJSONArray("items");
            int added = 0;
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.optJSONObject(i);
                    if (it == null) continue;
                    long cursor = it.optLong("cursor", -1L);
                    if (cursor < 0 || seen.contains(cursor)) continue;
                    String text = it.optString("text", "");
                    if (text.trim().isEmpty()) continue;
                    Line l = new Line();
                    l.cursor = cursor;
                    l.role = it.optString("role", "coo");
                    l.text = text;
                    l.ts = it.optString("ts", "");
                    seen.add(cursor);
                    lines.add(l);
                    addLine(l);
                    added++;
                }
            }
            if (next > 0) after = next;
            status.setText("已同步 " + lines.size() + " 条 · 每 2.5 秒自动刷新");
            if (added > 0 || firstLoad) scrollToEnd();
            firstLoad = false;
        } catch (JSONException e) {
            status.setText("数据没读明白，稍后重试");
        }
    }

    private void sendLine() {
        final String text = input.getText().toString().trim();
        if (text.isEmpty() || host.isEmpty() || token.isEmpty()) return;
        input.setText("");
        sendButton.setEnabled(false);
        status.setText("正在发送…");
        String payload;
        try {
            payload = new JSONObject().put("text", text).toString();
        } catch (JSONException e) {
            sendButton.setEnabled(true);
            status.setText("发送失败：内容格式不对");
            return;
        }
        final String body = payload;
        final String url = api("/api/m/chat/send");
        new Thread(new Runnable() {
            @Override public void run() {
                final String reply = httpPost(url, body);
                ui.post(new Runnable() {
                    @Override public void run() {
                        sendButton.setEnabled(true);
                        boolean ok = false;
                        boolean pet = false;
                        try {
                            JSONObject o = new JSONObject(reply);
                            ok = o.optBoolean("ok", false);
                            pet = o.optBoolean("petConnected", false);
                        } catch (Exception ignored) {
                            // an empty / non-JSON reply is a failed send
                        }
                        if (!ok) {
                            status.setText("没发出去 · 检查网络或回主界面重取地址");
                            return;
                        }
                        status.setText(pet
                                ? "已发出 · 等 Coo 回话…"
                                : "已发出，但桌宠没连上，Coo 可能不会回话（去开悬浮宠物）");
                        loading = false;
                        poll();
                    }
                });
            }
        }).start();
    }

    // ---------------------------------------------------------------- network

    private String readAll(HttpURLConnection c, int code) {
        InputStream in = null;
        try {
            in = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
            if (in == null) return "";
            BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            return sb.toString();
        } catch (Exception e) {
            return "";
        } finally {
            if (in != null) try { in.close(); } catch (Exception ignored) { }
        }
    }

    private String httpGet(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(7000);
            c.setReadTimeout(12000);
            c.setRequestProperty("User-Agent", "CooConsole/2.5");
            c.setRequestProperty("Cache-Control", "no-cache");
            return readAll(c, c.getResponseCode());
        } catch (Exception e) {
            return "";
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private String httpPost(String url, String payload) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(7000);
            c.setReadTimeout(12000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setRequestProperty("User-Agent", "CooConsole/2.5");
            byte[] bytes = payload.getBytes("UTF-8");
            c.setFixedLengthStreamingMode(bytes.length);
            OutputStream os = c.getOutputStream();
            os.write(bytes);
            os.close();
            return readAll(c, c.getResponseCode());
        } catch (Exception e) {
            return "";
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
