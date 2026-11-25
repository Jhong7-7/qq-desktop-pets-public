package coo.console;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;

/**
 * Optional global keyboard detector.
 *
 * An overlay window cannot see the IME of another app, so when the user types
 * in WeChat / Chrome / anywhere else, this service is the only way to know a
 * keyboard appeared. It only looks at WINDOW TYPES AND BOUNDS - it never reads
 * window content, text, or notifications, and it never touches the network.
 *
 * The user enables it once from the in-app menu. Without it, keyboard hopping
 * still works while typing inside Coo itself (and on ROMs that shrink the
 * overlay's own visible frame).
 */
public final class KeyboardWatchService extends AccessibilityService {

    private static final long TICK_MS = 260L;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            probe();
            handler.postDelayed(this, TICK_MS);
        }
    };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, TICK_MS);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event != null) {
            int type = event.getEventType();
            if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                    || type == AccessibilityEvent.TYPE_WINDOWS_CHANGED) {
                probe();
            }
        }
    }

    @Override
    public void onInterrupt() { }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        FloatingPet.onImeChanged(FloatingPet.IME_SRC_ACC, false, 0);
        super.onDestroy();
    }

    private void probe() {
        if (!FloatingPet.isShowing()) {
            // Keep reporting "no keyboard" so a stale 'shown' never sticks.
            FloatingPet.onImeChanged(FloatingPet.IME_SRC_ACC, false, 0);
            return;
        }
        boolean found = false;
        int top = Integer.MAX_VALUE;
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            for (AccessibilityWindowInfo w : windows) {
                if (w == null || w.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
                    continue;
                }
                Rect r = new Rect();
                w.getBoundsInScreen(r);
                if (r.height() <= 0) {
                    continue;
                }
                if (r.top > 0) {
                    top = Math.min(top, r.top);
                } else {
                    // A few IMEs report a full-screen window instead of just the
                    // keyboard area. Fall back to a conservative estimate so the
                    // pet still lands above the keys.
                    int screenH = getResources().getDisplayMetrics().heightPixels;
                    top = Math.min(top, (int) (screenH * 0.58f));
                }
                found = true;
            }
        } catch (Throwable ignored) {
            found = false;
        }
        FloatingPet.onImeChanged(FloatingPet.IME_SRC_ACC, found,
                found && top != Integer.MAX_VALUE ? top : 0);
    }
}
