import 'dart:async';
import 'package:firebase_auth/firebase_auth.dart';

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

  // ── Step 1: send OTP ────────────────────────────────────────────────────

  /// Triggers Firebase to send an SMS OTP to [phoneNumber].
  ///
  /// [phoneNumber] must include the country code, e.g. "+919876543210".
  ///
  /// Returns an [OtpSendResult]:
  ///   - If Android auto-verifies → result.idToken is ready, skip code entry.
  ///   - Otherwise             → result.verificationId, ask user for code.
  ///
  /// Throws [FirebaseAuthException] on failure.
  Future<OtpSendResult> sendOtp(String phoneNumber) async {
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
        // Timeout reached without auto-resolve.
        // Only complete if we haven't already completed via codeSent.
        if (!completer.isCompleted) {
          completer.complete(OtpSendResult(verificationId: verificationId));
        }
      },
    );

    return completer.future;
  }

  // ── Step 2: verify OTP code ─────────────────────────────────────────────

  /// Signs in with the [smsCode] the user typed and the [verificationId]
  /// returned by [sendOtp].
  ///
  /// Returns the Firebase ID token (a JWT) to pass to your backend.
  ///
  /// Throws [FirebaseAuthException] if the code is wrong / expired.
  Future<String> verifyOtp({
    required String verificationId,
    required String smsCode,
  }) async {
    final credential = PhoneAuthProvider.credential(
      verificationId: verificationId,
      smsCode: smsCode,
    );
    final userCred = await _auth.signInWithCredential(credential);
    final token = await userCred.user?.getIdToken();
    if (token == null) throw Exception('Failed to get Firebase ID token');
    return token;
  }

  // ── Sign out from Firebase ───────────────────────────────────────────────

  Future<void> signOut() => _auth.signOut();
}
