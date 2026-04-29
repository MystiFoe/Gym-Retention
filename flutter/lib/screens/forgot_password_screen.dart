import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../utils/error_helper.dart';

enum _ForgotStep { enterEmail, enterOtp }

class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  final _emailController = TextEditingController();
  final _otpController   = TextEditingController();

  _ForgotStep _step     = _ForgotStep.enterEmail;
  bool  _loading        = false;
  bool  _resendLoading  = false;
  String? _error;
  String? _success;

  @override
  void dispose() {
    _emailController.dispose();
    _otpController.dispose();
    super.dispose();
  }

  String get _maskedEmail {
    final e = _emailController.text.trim();
    final parts = e.split('@');
    if (parts.length != 2 || parts[0].length <= 2) return e;
    final local = parts[0];
    return '${local[0]}${'*' * (local.length - 2)}${local[local.length - 1]}@${parts[1]}';
  }

  // ── Step 1: send OTP to email ───────────────────────────────────────────

  Future<void> _sendOtp() async {
    final email = _emailController.text.trim();
    if (email.isEmpty || !email.contains('@')) {
      setState(() => _error = 'Please enter a valid email address.');
      return;
    }
    setState(() { _loading = true; _error = null; _success = null; });
    try {
      await ApiService().forgotPassword(email: email);
      if (!mounted) return;
      setState(() {
        _loading = false;
        _step    = _ForgotStep.enterOtp;
        _success = 'A 6-digit code was sent to $_maskedEmail';
      });
    } catch (e) {
      if (mounted) setState(() { _loading = false; _error = friendlyError(e); });
    }
  }

  // ── Step 2: verify OTP → get reset token → navigate ────────────────────

  Future<void> _verifyOtp() async {
    final code = _otpController.text.trim();
    if (code.length != 6) {
      setState(() => _error = 'Please enter the 6-digit code from your email.');
      return;
    }
    setState(() { _loading = true; _error = null; _success = null; });
    try {
      final resetToken = await ApiService().verifyResetOtp(
        email:   _emailController.text.trim(),
        otpCode: code,
      );
      if (!mounted) return;
      context.push('/reset-password?token=$resetToken');
    } catch (e) {
      if (mounted) setState(() { _loading = false; _error = friendlyError(e); });
    }
  }

  // ── Resend ──────────────────────────────────────────────────────────────

  Future<void> _resend() async {
    setState(() { _resendLoading = true; _error = null; _success = null; });
    try {
      await ApiService().forgotPassword(email: _emailController.text.trim());
      if (mounted) {
        setState(() {
          _resendLoading = false;
          _success = 'A new code has been sent.';
          _otpController.clear();
        });
      }
    } catch (e) {
      if (mounted) setState(() { _resendLoading = false; _error = friendlyError(e); });
    }
  }

  // ── UI ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Forgot Password'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () {
            if (_step == _ForgotStep.enterOtp) {
              setState(() { _step = _ForgotStep.enterEmail; _error = null; _success = null; });
            } else {
              context.canPop() ? context.pop() : context.go('/login');
            }
          },
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: _step == _ForgotStep.enterEmail
              ? _emailStep()
              : _otpStep(),
        ),
      ),
    );
  }

  // ── Email entry step ────────────────────────────────────────────────────

  Widget _emailStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 40),
        const Icon(Icons.lock_reset, size: 72, color: Color(0xFF2196F3)),
        const SizedBox(height: 20),
        Text(
          'Reset Password',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineMedium?.copyWith(
            fontWeight: FontWeight.bold, color: const Color(0xFF2196F3),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          'Enter your registered email address.\nWe\'ll send a 6-digit verification code.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
        ),
        const SizedBox(height: 32),

        if (_error != null) ...[_banner(_error!, isError: true), const SizedBox(height: 16)],

        TextField(
          controller: _emailController,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          decoration: InputDecoration(
            labelText: 'Email Address',
            prefixIcon: const Icon(Icons.email_outlined),
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
            onPressed: _loading ? null : _sendOtp,
            icon: _loading
                ? const SizedBox(width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.send),
            label: Text(
              _loading ? 'Sending…' : 'Send Verification Code',
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
          ),
        ),
        const SizedBox(height: 16),
        TextButton(
          onPressed: () => context.canPop() ? context.pop() : context.go('/login'),
          child: const Text('Back to Login'),
        ),
        const SizedBox(height: 24),
        // Phone OTP option
        Row(children: [
          const Expanded(child: Divider()),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text('or', style: TextStyle(color: Colors.grey[500])),
          ),
          const Expanded(child: Divider()),
        ]),
        const SizedBox(height: 16),
        OutlinedButton.icon(
          onPressed: () => context.push(
            '/phone-otp',
            extra: {'mode': 'forgotPassword', 'role': 'owner'},
          ),
          icon: const Icon(Icons.phone_android),
          label: const Text('Reset via Phone OTP'),
          style: OutlinedButton.styleFrom(
            side: const BorderSide(color: Color(0xFF2196F3)),
            foregroundColor: const Color(0xFF2196F3),
            padding: const EdgeInsets.symmetric(vertical: 14),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          ),
        ),
      ],
    );
  }

  // ── OTP entry step ──────────────────────────────────────────────────────

  Widget _otpStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 40),
        const Icon(Icons.mark_email_unread_outlined, size: 72, color: Color(0xFF2196F3)),
        const SizedBox(height: 20),
        Text(
          'Enter Verification Code',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.bold, color: const Color(0xFF2196F3),
          ),
        ),
        const SizedBox(height: 12),
        RichText(
          textAlign: TextAlign.center,
          text: TextSpan(
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[700]),
            children: [
              const TextSpan(text: 'We sent a 6-digit code to\n'),
              TextSpan(
                text: _maskedEmail,
                style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF1a1a1a)),
              ),
            ],
          ),
        ),
        const SizedBox(height: 32),

        if (_error != null) ...[_banner(_error!, isError: true), const SizedBox(height: 16)],
        if (_success != null) ...[_banner(_success!, isError: false), const SizedBox(height: 16)],

        // OTP input
        TextField(
          controller: _otpController,
          keyboardType: TextInputType.number,
          maxLength: 6,
          textAlign: TextAlign.center,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          style: const TextStyle(
            fontSize: 32, fontWeight: FontWeight.bold, letterSpacing: 12,
          ),
          decoration: InputDecoration(
            labelText: '6-digit code',
            counterText: '',
            hintText: '——————',
            hintStyle: TextStyle(color: Colors.grey[300], fontSize: 32, letterSpacing: 12),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: Color(0xFF2196F3), width: 2),
            ),
          ),
          onChanged: (_) { if (_error != null) setState(() => _error = null); },
        ),
        const SizedBox(height: 28),

        SizedBox(
          height: 54,
          child: ElevatedButton.icon(
            onPressed: _loading ? null : _verifyOtp,
            icon: _loading
                ? const SizedBox(width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.lock_open_outlined),
            label: Text(
              _loading ? 'Verifying…' : 'Verify & Reset Password',
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
          ),
        ),
        const SizedBox(height: 20),

        // Resend
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text("Didn't receive it? ", style: TextStyle(color: Colors.grey[600])),
            _resendLoading
                ? const SizedBox(width: 18, height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : TextButton(
                    onPressed: _resend,
                    child: const Text('Resend Code'),
                  ),
          ],
        ),

        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.blue.withValues(alpha: 0.06),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: Colors.blue.withValues(alpha: 0.2)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.info_outline, size: 16, color: Color(0xFF2196F3)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Check your spam/junk folder if you don\'t see it. Code is valid for 15 minutes.',
                  style: TextStyle(fontSize: 12, color: Colors.grey[600]),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _banner(String message, {required bool isError}) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isError
            ? Colors.red.withValues(alpha: 0.1)
            : Colors.green.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: isError ? Colors.red : Colors.green),
      ),
      child: Text(
        message,
        style: TextStyle(color: isError ? Colors.red : Colors.green[700]),
      ),
    );
  }
}
