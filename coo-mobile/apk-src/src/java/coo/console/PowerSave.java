package coo.console;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.PowerManager;
import android.webkit.WebView;

import java.util.ArrayList;

/**
 * v2.5: the pet used to keep a full WebView, its WebGL frame loop, a 220ms
 * keyboard probe, three JS intervals and a character-by-character bubble
 * animation running while the phone's screen was OFF. None of that can be
 * seen by anybody, but all of it wakes the CPU and holds the radio awake.
 *
 * ACTION_SCREEN_OFF / ACTION_SCREEN_ON / ACTION_USER_PRESENT cannot be put in
 * the manifest (Android only delivers them to dynamically registered
 * receivers), so MainActivity registers this once with the application
 * context. It then:
 *
 *   - pauses / resumes ALL WebView JS timers (a global WebView switch),
 *   - asks FloatingPet to pause its own WebView, keyboard probe and bubble,
 *   - lets ChatActivity and the crop follower stop polling.
 *
 * SCREEN_ON and USER_PRESENT both arrive on most phones, so setScreenOff()
 * is idempotent and does nothing on a repeated "wake up".
 */
public final class PowerSave {

    private static volatile boolean off = false;
    private static boolean installed = false;
    private static final ArrayList<WebView> ANCHORS = new ArrayList<>();

    private PowerSave() { }

    /** Call once from MainActivity.onCreate(); safe to call again. */
    public static synchronized void install(Context app) {
        if (installed) {
            return;
        }
        final Context c = app.getApplicationContext();
        BroadcastReceiver rx = new BroadcastReceiver() {
            @Override public void onReceive(Context ctx, Intent i) {
                String a = i == null ? "" : i.getAction();
                if (Intent.ACTION_SCREEN_OFF.equals(a)) {
                    setScreenOff(true);
                } else if (Intent.ACTION_SCREEN_ON.equals(a)
                        || Intent.ACTION_USER_PRESENT.equals(a)) {
                    setScreenOff(false);
                }
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_SCREEN_OFF);
        f.addAction(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_USER_PRESENT);
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                c.registerReceiver(rx, f, Context.RECEIVER_NOT_EXPORTED);
            } else {
                c.registerReceiver(rx, f);
            }
            installed = true;
        } catch (Exception ignored) {
            // No receiver: the app simply behaves like v2.4.
        }
    }

    /**
     * pauseTimers()/resumeTimers() are instance methods with a GLOBAL effect,
     * so any live WebView will do. Keep a few; destroyed ones are skipped.
     */
    public static synchronized void attach(WebView v) {
        if (v != null && !ANCHORS.contains(v)) {
            ANCHORS.add(v);
        }
        // A WebView created while the screen was already off must start quiet.
        if (off && v != null) {
            try { v.pauseTimers(); } catch (Throwable ignored) { }
        }
    }

    public static synchronized void detach(WebView v) {
        ANCHORS.remove(v);
    }

    public static boolean isScreenOff() {
        return off;
    }

    /**
     * Fallback for ROMs that do not deliver SCREEN_ON/OFF to dynamic receivers:
     * MainActivity calls this on every resume/pause and on cold start, so the
     * real display state wins even if no broadcast ever arrives.
     */
    public static void syncInteractive(Context c) {
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                setScreenOff(!pm.isInteractive());
            }
        } catch (Throwable ignored) { }
    }

    private static synchronized void setScreenOff(boolean value) {
        if (off == value) {
            return;                         // SCREEN_ON + USER_PRESENT both fire
        }
        off = value;
        globalTimers(!value);               // true = pause
        if (value) {
            FloatingPet.onScreenOff();
        } else {
            FloatingPet.onScreenOn();
        }
    }

    private static void globalTimers(boolean pause) {
        for (WebView v : ANCHORS) {
            try {
                if (pause) {
                    v.pauseTimers();
                } else {
                    v.resumeTimers();
                }
                return;                     // global switch: one call is enough
            } catch (Throwable ignored) {
                // that WebView was destroyed; try the next one
            }
        }
    }
}
