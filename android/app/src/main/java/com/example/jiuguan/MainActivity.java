package com.example.jiuguan;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GenerationForegroundPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
