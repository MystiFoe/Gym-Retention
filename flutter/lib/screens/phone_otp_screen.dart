import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';
import '../services/api_service.dart';
import '../services/firebase_service.dart';
import '../utils/error_helper.dart';

/// How this screen is being used.
enum OtpMode {
  /// Login via phone OTP (no password needed).
  login,

  /// Step 3 of registration: verify phone then complete account creation.
  /// Requires [PhoneOtpScreen.pendingId] and [PhoneOtpScreen.businessPhone].
  registrationPhoneVerify,

  /// Forgot-password flow: verify phone → get reset token → reset password.
  forgotPassword,
}

class PhoneOtpScreen extends StatefulWidget {
  final OtpMode mode;

  /// Required for [OtpMode.login] — 'owner' or 'trainer'.
  final String role;

  /// Required for [OtpMode.registrationPhoneVerify] — pending registration id.
  final String pendingId;

  /// Pre-fills the phone field for [OtpMode.registrationPhoneVerify].
  final String businessPhone;

  const PhoneOtpScreen({
    super.key,
    this.mode = OtpMode.login,
    this.role = 'owner',
    this.pendingId = '',
    this.businessPhone = '',
  });

  @override
  State<PhoneOtpScreen> createState() => _PhoneOtpScreenState();
}

class _PhoneOtpScreenState extends State<PhoneOtpScreen> {
  // ── Controllers ────────────────────────────────────────────────────────
  final _phoneController = TextEditingController();
  final _otpController   = TextEditingController();

  // ── State ──────────────────────────────────────────────────────────────
  bool _codeSent    = false;
  bool _loading     = false;
  String? _error;
  String? _verificationId; // null when auto-verified
  late String _role;       // mutable for login mode role selector

  @override
  void initState() {
    super.initState();
    _role = widget.role;
    // Pre-fill phone for registration flow so user knows which number to verify.
    if (widget.mode == OtpMode.registrationPhoneVerify &&
        widget.businessPhone.isNotEmpty) {
      _phoneController.text = widget.businessPhone;
    }
  }

  @override
  void dispose() {
    _phoneController.dispose();
    _otpController.dispose();
    super.dispose();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  String get _title {
    switch (widget.mode) {
      case OtpMode.login:                   return 'Login with OTP';
      case OtpMode.registrationPhoneVerify: return 'Verify Your Phone';
      case OtpMode.forgotPassword:          return 'Forgot Password';
    }
  }

  String get _subtitle {
    switch (widget.mode) {
      case OtpMode.login:
        return 'Enter your registered phone number';
      case OtpMode.registrationPhoneVerify:
        return 'Step 2 of 2 — Verify your business phone number to complete registration';
      case OtpMode.forgotPassword:
        return 'Enter your registered phone to reset password';
    }
  }

  // ── Step 1: Send OTP ───────────────────────────────────────────────────

  Future<void> _sendOtp() async {
    final phone = _phoneController.text.trim();
    if (phone.isEmpty) {
      setState(() => _error = 'Please enter your phone number');
      return;
    }
    // Ensure E.164 format
    final e164 = phone.startsWith('+') ? phone : '+91$phone';

    setState(() { _loading = true; _error = null; });
    try {
      final result = await FirebaseService().sendOtp(e164);

      if (!mounted) return;

      if (result.autoVerified && result.idToken != null) {
        // Android auto-verified — skip code entry, go straight to backend
        await _callBackend(result.idToken!);
      } else {
        setState(() {
          _verificationId = result.verificationId;
          _codeSent = true;
          _loading  = false;
        });
      }
    } on FirebaseAuthException catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error   = _friendlyFirebaseError(e);
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error   = 'Failed to send OTP. Check your phone number and try again.';
        });
      }
    }
  }

  // ── Step 2: Verify Code ────────────────────────────────────────────────

  Future<void> _verifyCode() async {
    final code = _otpController.text.trim();
    if (code.length != 6) {
      setState(() => _error = 'Enter the 6-digit code from your SMS');
      return;
    }
    if (_verificationId == null) return;

    setState(() { _loading = true; _error = null; });
    try {
      final idToken = await FirebaseService().verifyOtp(
        verificationId: _verificationId!,
        smsCode: code,
      );
      if (!mounted) return;
      await _callBackend(idToken);
    } on FirebaseAuthException catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error   = _friendlyFirebaseError(e);
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error   = friendlyError(e);
        });
      }
    }
  }

  // ── Step 3: Backend call ───────────────────────────────────────────────

  Future<void> _callBackend(String firebaseIdToken) async {
    try {
      switch (widget.mode) {
        case OtpMode.login:
          // Exchange Firebase token for app JWT
          await ApiService().verifyFirebaseToken(
            firebaseIdToken: firebaseIdToken,
            role: _role,
          );
          // Register FCM token after login
          FirebaseMessaging.instance.getToken().then((token) {
            if (token != null) ApiService().updateFcmToken(token);
          });
          if (!mounted) return;
          if (_role == 'trainer') {
            AppRoutes.pushAndRemoveUntil(RouteNames.trainerDashboard);
          } else {
            AppRoutes.pushAndRemoveUntil(RouteNames.ownerDashboard);
          }
          break;

        case OtpMode.registrationPhoneVerify:
          // Complete registration: creates gym+user records and issues JWTs.
          await ApiService().completeRegistration(
            pendingId: widget.pendingId,
            firebaseIdToken: firebaseIdToken,
          );
          // Register FCM token after registration login
          FirebaseMessaging.instance.getToken().then((token) {
            if (token != null) ApiService().updateFcmToken(token);
          });
          if (!mounted) return;
          // Auto-logged in — go straight to the owner dashboard.
          AppRoutes.pushAndRemoveUntil(RouteNames.ownerDashboard);
          break;

        case OtpMode.forgotPassword:
          // Get a password-reset token from backend
          final resetToken = await ApiService().phoneResetToken(
            firebaseIdToken: firebaseIdToken,
          );
          if (!mounted) return;
          context.push('/reset-password?token=$resetToken');
          break;
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error   = friendlyError(e);
        });
      }
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_title),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () {
            if (widget.mode == OtpMode.registrationPhoneVerify) {
              context.go('/login');
            } else {
              context.canPop() ? context.pop() : context.go('/login');
            }
          },
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: _codeSent ? _codeStep() : _phoneStep(),
        ),
      ),
    );
  }

  // ── Phone entry step ───────────────────────────────────────────────────

  Widget _phoneStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 32),
        const Icon(Icons.phone_android, size: 72, color: Color(0xFF2196F3)),
        const SizedBox(height: 20),
        Text(
          _title,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.bold, color: const Color(0xFF2196F3),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          _subtitle,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
        ),
        const SizedBox(height: 32),

        if (_error != null) ...[
          _errorBanner(_error!),
          const SizedBox(height: 16),
        ],

        // Role selector only for login mode (not registration or forgot-password)
        if (widget.mode == OtpMode.login) ...[
          DropdownButtonFormField<String>(
            initialValue: _role,
            decoration: InputDecoration(
              labelText: 'Role',
              prefixIcon: const Icon(Icons.badge),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: Color(0xFF2196F3), width: 2),
              ),
            ),
            items: const [
              DropdownMenuItem(value: 'owner',   child: Text('Business Owner')),
              DropdownMenuItem(value: 'trainer', child: Text('Staff')),
            ],
            onChanged: (v) => setState(() => _role = v ?? 'owner'),
          ),
          const SizedBox(height: 16),
        ],

        TextField(
          controller: _phoneController,
          keyboardType: TextInputType.phone,
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+]'))],
          decoration: InputDecoration(
            labelText: 'Phone Number',
            hintText: '+91 98765 43210',
            prefixIcon: const Icon(Icons.phone),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: Color(0xFF2196F3), width: 2),
            ),
            helperText: 'Include country code, e.g. +91 for India',
          ),
        ),
        const SizedBox(height: 28),

        SizedBox(
          height: 54,
          child: ElevatedButton.icon(
            onPressed: _loading ? null : _sendOtp,
            icon: _loading
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.send),
            label: Text(
              _loading ? 'Sending…' : 'Send OTP',
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
          ),
        ),
        const SizedBox(height: 16),
        TextButton(
          onPressed: () => context.canPop() ? context.pop() : context.go('/login'),
          child: const Text('Back to Login'),
        ),
      ],
    );
  }

  // ── Code entry step ────────────────────────────────────────────────────

  Widget _codeStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 32),
        const Icon(Icons.sms_outlined, size: 72, color: Color(0xFF2196F3)),
        const SizedBox(height: 20),
        Text(
          'Enter OTP',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.bold, color: const Color(0xFF2196F3),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          'We sent a 6-digit code to ${_phoneController.text.trim()}',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
        ),
        const SizedBox(height: 32),

        if (_error != null) ...[
          _errorBanner(_error!),
          const SizedBox(height: 16),
        ],

        TextField(
          controller: _otpController,
          keyboardType: TextInputType.number,
          maxLength: 6,
          textAlign: TextAlign.center,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          style: const TextStyle(fontSize: 28, fontWeight: FontWeight.bold, letterSpacing: 8),
          decoration: InputDecoration(
            labelText: '6-digit code',
            counterText: '',
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: Color(0xFF2196F3), width: 2),
            ),
          ),
        ),
        const SizedBox(height: 28),

        SizedBox(
          height: 54,
          child: ElevatedButton.icon(
            onPressed: _loading ? null : _verifyCode,
            icon: _loading
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.verified),
            label: Text(
              _loading ? 'Verifying…' : 'Verify & Continue',
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
          ),
        ),
        const SizedBox(height: 16),

        // Resend
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text("Didn't receive it? ", style: TextStyle(color: Colors.grey[600])),
            TextButton(
              onPressed: _loading ? null : () {
                setState(() { _codeSent = false; _error = null; _otpController.clear(); });
              },
              child: const Text('Resend OTP'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _errorBanner(String message) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.red.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.red),
      ),
      child: Text(message, style: const TextStyle(color: Colors.red)),
    );
  }

  String _friendlyFirebaseError(FirebaseAuthException e) {
    switch (e.code) {
      case 'invalid-phone-number':    return 'Invalid phone number format. Include country code (e.g. +91).';
      case 'too-many-requests':       return 'Too many attempts. Please try again later.';
      case 'invalid-verification-code': return 'Wrong OTP code. Please check and try again.';
      case 'session-expired':         return 'OTP expired. Please request a new one.';
      case 'quota-exceeded':          return 'SMS quota exceeded. Try again later.';
      case 'network-request-failed':  return 'Network error. Check your internet connection.';
      default: return e.message ?? 'An error occurred. Please try again.';
    }
  }
}
