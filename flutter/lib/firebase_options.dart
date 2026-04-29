// ============================================================================
// FIREBASE OPTIONS — PLACEHOLDER
// ============================================================================
// Replace all placeholder values below with your real Firebase project config.
//
// EASIEST WAY:
//   1. Install FlutterFire CLI:  dart pub global activate flutterfire_cli
//   2. Run:                      flutterfire configure
//   3. This file will be auto-generated with correct values.
//
// MANUAL WAY (Firebase Console → Project Settings → Your Apps):
//   Fill in each field from the Android / iOS app config.
// ============================================================================

import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) return web;
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      default:
        throw UnsupportedError(
          'DefaultFirebaseOptions have not been configured for this platform.',
        );
    }
  }

  // ── Android ────────────────────────────────────────────────────────────────
  static const FirebaseOptions android = FirebaseOptions(
    apiKey:            'AIzaSyC7hJ02xdmpFgIfIp4_iKKcobdoPuELBpc',
    appId:             '1:611414847570:android:4f5dba080a9c9b0113ef8b',
    messagingSenderId: '611414847570',
    projectId:         'recurva-app',
    storageBucket:     'recurva-app.firebasestorage.app',
  );

  // ── iOS ────────────────────────────────────────────────────────────────────
  // From: GoogleService-Info.plist
  static const FirebaseOptions ios = FirebaseOptions(
    apiKey:            'YOUR_IOS_API_KEY',            // TODO
    appId:             '1:000000000000:ios:0000',     // TODO
    messagingSenderId: '000000000000',                // TODO
    projectId:         'YOUR_PROJECT_ID',             // TODO
    storageBucket:     'YOUR_PROJECT_ID.appspot.com', // TODO
    iosBundleId:       'com.example.gymFitnessApp',   // TODO — match your bundle ID
  );

  // ── Web ────────────────────────────────────────────────────────────────────
  static const FirebaseOptions web = FirebaseOptions(
    apiKey:            'AIzaSyAe8JM6ujliEcX3zXIaYy07cnARLzof-fc',
    appId:             '1:611414847570:web:2efb4186907bb66c13ef8b',
    messagingSenderId: '611414847570',
    projectId:         'recurva-app',
    storageBucket:     'recurva-app.firebasestorage.app',
    authDomain:        'recurva-app.firebaseapp.com',
    measurementId:     'G-6N7KJR5ERC',
  );
}
