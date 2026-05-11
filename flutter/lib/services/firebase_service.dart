import 'dart:async';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

/// Result returned by [FirebaseService.sendOtp].
///
/// On Android, Firebase may auto-resolve the OTP (verificationCompleted).
/// In that case [idToken] is set and you can skip the code-entry step.
/// Otherwise [verificationId] is set and the user must type the 6-digit code.
class OtpSendResult {
  final String? verificationId;
  final String? idToken; // set when Android auto-verifies
  OtpSendResult({this.verificationId, this.idToken});
  bool get autoVerified => idToken != null;
}

class FirebaseService {
  static final FirebaseService _instance = FirebaseService._internal();
  factory FirebaseService() => _instance;
  FirebaseService._internal();

  final FirebaseAuth _auth = FirebaseAuth.instance;

  // Web-only: holds the confirmation result from signInWithPhoneNumber
  ConfirmationResult? _webConfirmationResult;

  // ── Step 1: send OTP ────────────────────────────────────────────────────

  /// Triggers Firebase to send an SMS OTP to [phoneNumber].
  /// [phoneNumber] must include the country code, e.g. "+919876543210".
  ///
  /// On web  → uses signInWithPhoneNumber + invisible reCAPTCHA.
  /// On mobile → uses verifyPhoneNumber (Android auto-retrieval supported).
  ///
  /// Throws [FirebaseAuthException] on failure.
  Future<OtpSendResult> sendOtp(String phoneNumber) async {
    if (kIsWeb) {
      // Web path: pass no RecaptchaVerifier — Firebase creates an invisible one
      // automatically (auth._delegate is set internally). Container=null → invisible.
      _webConfirmationResult = await _auth.signInWithPhoneNumber(phoneNumber);
      return OtpSendResult(verificationId: 'web');
    }

    // Mobile path
    final completer = Completer<OtpSendResult>();

    await _auth.verifyPhoneNumber(
      phoneNumber: phoneNumber,
      timeout: const Duration(seconds: 60),

      // Android auto-SMS-retrieval — skip code entry
      verificationCompleted: (PhoneAuthCredential credential) async {
        if (completer.isCompleted) return;
        try {
          final userCred = await _auth.signInWithCredential(credential);
          final token = await userCred.user?.getIdToken();
          completer.complete(OtpSendResult(idToken: token));
        } catch (e) {
          completer.completeError(e);
        }
      },

      // SMS sent → user must type code
      codeSent: (String verificationId, int? resendToken) {
        if (!completer.isCompleted) {
          completer.complete(OtpSendResult(verificationId: verificationId));
        }
      },

      verificationFailed: (FirebaseAuthException e) {
        if (!completer.isCompleted) completer.completeError(e);
      },

      codeAutoRetrievalTimeout: (String verificationId) {
        if (!completer.isCompleted) {
          completer.complete(OtpSendResult(verificationId: verificationId));
        }
      },
    );

    return completer.future;
  }

  // ── Step 2: verify OTP code ─────────────────────────────────────────────

  /// Confirms the [smsCode] entered by the user.
  /// Returns the Firebase ID token to pass to the backend for server-side
  /// verification.
  ///
  /// Throws [FirebaseAuthException] if the code is wrong / expired.
  Future<String> verifyOtp({
    required String verificationId,
    required String smsCode,
  }) async {
    UserCredential userCred;

    if (kIsWeb) {
      if (_webConfirmationResult == null) throw Exception('No active OTP session. Please request a new code.');
      userCred = await _webConfirmationResult!.confirm(smsCode);
      _webConfirmationResult = null;
    } else {
      final credential = PhoneAuthProvider.credential(
        verificationId: verificationId,
        smsCode: smsCode,
      );
      userCred = await _auth.signInWithCredential(credential);
    }

    final token = await userCred.user?.getIdToken();
    if (token == null) throw Exception('Failed to get Firebase ID token');
    return token;
  }

  // ── Sign out from Firebase ───────────────────────────────────────────────

  Future<void> signOut() => _auth.signOut();
}
