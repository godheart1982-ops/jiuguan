package com.example.jiuguan;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "GenerationForeground")
public class GenerationForegroundPlugin extends Plugin {

    private static final int REQUEST_CODE_NOTIFICATION_PERMISSION = 1001;

    @PluginMethod
    public void start(PluginCall call) {
        if (getContext() == null) {
            call.reject("Context is null");
            return;
        }

        String title = call.getString("title", getContext().getString(R.string.generation_notification_title));
        String text = call.getString("text", getContext().getString(R.string.generation_notification_text));

        Intent intent = new Intent(getContext(), GenerationForegroundService.class);
        intent.putExtra("title", title);
        intent.putExtra("text", text);

        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("无法启动前台服务: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (getContext() == null) {
            call.reject("Context is null");
            return;
        }

        try {
            Intent intent = new Intent(getContext(), GenerationForegroundService.class);
            getContext().stopService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("无法停止前台服务: " + e.getMessage());
        }
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        if (getContext() == null) {
            call.reject("Context is null");
            return;
        }

        PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        if (pm == null) {
            call.reject("无法获取 PowerManager");
            return;
        }

        if (pm.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            startActivityForResult(call, intent, "batteryOptimizationResult");
        } catch (Exception e) {
            call.reject("无法打开电池优化设置: " + e.getMessage());
        }
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);

        PluginCall savedCall = getSavedCall();
        if (savedCall == null) {
            return;
        }

        PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        boolean granted = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        savedCall.resolve(ret);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        if (getContext() == null || getActivity() == null) {
            call.reject("Context or Activity is null");
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("无法打开应用设置: " + e.getMessage());
        }
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (getContext() == null) {
            call.reject("Context is null");
            return;
        }

        // Android 13 以下不需要运行时请求通知权限
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }

        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }

        if (getActivity() == null) {
            call.reject("Activity is null");
            return;
        }

        saveCall(call);
        ActivityCompat.requestPermissions(getActivity(),
                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                REQUEST_CODE_NOTIFICATION_PERMISSION);
    }

    @Override
    protected void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.handleRequestPermissionsResult(requestCode, permissions, grantResults);

        PluginCall savedCall = getSavedCall();
        if (savedCall == null) {
            return;
        }

        if (requestCode == REQUEST_CODE_NOTIFICATION_PERMISSION) {
            boolean granted = false;
            if (permissions != null && grantResults != null && permissions.length > 0) {
                for (int i = 0; i < permissions.length; i++) {
                    if (Manifest.permission.POST_NOTIFICATIONS.equals(permissions[i])
                            && grantResults[i] == PackageManager.PERMISSION_GRANTED) {
                        granted = true;
                        break;
                    }
                }
            }
            JSObject ret = new JSObject();
            ret.put("granted", granted);
            savedCall.resolve(ret);
        }
    }
}
