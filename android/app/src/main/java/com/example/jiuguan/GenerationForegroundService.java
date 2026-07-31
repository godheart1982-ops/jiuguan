package com.example.jiuguan;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

public class GenerationForegroundService extends Service {

    private static final String TAG = "GenerationFgService";
    private static final String CHANNEL_ID = "jiuguan_generation_channel";
    private static final int NOTIFICATION_ID = 1;
    private static final String WAKE_LOCK_TAG = "jiuguan:generation_wakelock";
    private static final String WIFI_LOCK_TAG = "jiuguan:generation_wifilock";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "onCreate called");
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "onStartCommand called, startId=" + startId);
        String title = intent != null && intent.hasExtra("title")
                ? intent.getStringExtra("title")
                : getString(R.string.generation_notification_title);
        String text = intent != null && intent.hasExtra("text")
                ? intent.getStringExtra("text")
                : getString(R.string.generation_notification_text);

        Notification notification = buildNotification(title, text);

        int serviceType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
                : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;

        try {
            ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    notification,
                    serviceType
            );
            Log.d(TAG, "startForeground succeeded with type=" + serviceType);
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed: " + e.getMessage(), e);
            stopSelf();
            return START_NOT_STICKY;
        }

        acquireLocks();

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "onDestroy called");
        releaseLocks();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.generation_channel_name),
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription(getString(R.string.generation_channel_description));
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification(String title, String text) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setOngoing(true)
                .setContentIntent(pendingIntent)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    private void acquireLocks() {
        // 先释放旧的，避免多次启动后重复持有多个锁
        releaseLocks();

        try {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(10 * 60 * 1000L); // 最多持有 10 分钟，每次生成会重新刷新
                Log.d(TAG, "WakeLock acquired");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to acquire wake lock: " + e.getMessage(), e);
        }

        try {
            WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                int wifiLockMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wifiManager.createWifiLock(wifiLockMode, WIFI_LOCK_TAG);
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
                Log.d(TAG, "WifiLock acquired, mode=" + wifiLockMode);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to acquire wifi lock: " + e.getMessage(), e);
        }
    }

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
            wifiLock = null;
        }
    }
}
