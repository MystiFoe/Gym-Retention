import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../utils/error_helper.dart';

/// Step 2 of registration: user enters the 6-digit OTP sent to their email.
class EmailOtpRegistrationScreen extends StatefulWidget {
  final String pendingId;
  final String ownerEmail;

  const EmailOtpRegistrationScreen({
    super.key,
    required this.pendingId,
    required this.ownerEmail,
  });

  @override
  State<EmailOtpRegistrationScreen> createState() =>
      _EmailOtpRegistrationScreenState();
}

class _EmailOtpRegistrationScreenState
    extends State<EmailOtpRegistrationScreen> {
  final _otpController = TextEditingController();
  bool _loading = false;
  bool _resendLoading = false;
  String? _error;
  String? _successMessage;

  @override
  void dispose() {
    _otpController.dispose();
    super.dispose();
  }

  String _maskEmail(String email) {
    final parts = email.split('@');
    if (parts.length != 2) return email;
    final local = parts[0];
    if (local.length <= 2) return email;
    final masked =
        '${local[0]}${'*' * (local.length - 2)}${local[local.length - 1]}';
    return '$masked@${parts[1]}';
  }

  Future<void> _verifyOtp() async {
    final code = _otpController.text.trim();
    if (code.length != 6) {
      setState(() => _error = 'Please enter the 6-digit code from your email.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _successMessage = null;
    });

    try {
      final result = await ApiService().verifyRegistrationEmail(
        pendingId: widget.pendingId,
        otpCode: code,
      );

      if (!mounted) return;
      context.pushReplacement(
        '/phone-otp',
        extra: {
          'mode': 'registrationPhoneVerify',
          'role': 'owner',
          'pendingId': result.pendingId,
          'businessPhone': result.businessPhone,
        },
      );
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = friendlyError(e);
          _loading = false;
        });
      }
    }
  }

  Future<void> _resend() async {
    setState(() {
      _resendLoading = true;
      _error = null;
      _successMessage = null;
    });
    try {
      await ApiService().resendRegistrationEmailOtp(pendingId: widget.pendingId);
      if (mounted) {
        setState(() {
          _resendLoading = false;
          _successMessage = 'A new code has been sent to your email.';
          _otpController.clear();
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _resendLoading = false;
          _error = friendlyError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Verify Email'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/login'),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 32),

              // Icon
              const Icon(Icons.mark_email_unread_outlined,
                  size: 80, color: Color(0xFF2196F3)),
              const SizedBox(height: 24),

              // Title
              Text(
                'Enter Verification Code',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                      color: const Color(0xFF2196F3),
                    ),
              ),
              const SizedBox(height: 12),

              // Subtitle
              RichText(
                textAlign: TextAlign.center,
                text: TextSpan(
                  style: Theme.of(context)
                      .textTheme
                      .bodyMedium
                      ?.copyWith(color: Colors.grey[700]),
                  children: [
                    const TextSpan(text: 'We sent a 6-digit code to\n'),
                    TextSpan(
                      text: _maskEmail(widget.ownerEmail),
                      style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          color: Color(0xFF1a1a1a)),
                    ),
                    const TextSpan(
                        text: '\n\nEnter the code below to continue.'),
                  ],
                ),
              ),
              const SizedBox(height: 32),

              // Error / success banners
              if (_error != null) ...[
                _banner(_error!, isError: true),
                const SizedBox(height: 16),
              ],
              if (_successMessage != null) ...[
                _banner(_successMessage!, isError: false),
                const SizedBox(height: 16),
              ],

              // OTP input
              TextField(
                controller: _otpController,
                keyboardType: TextInputType.number,
                maxLength: 6,
                textAlign: TextAlign.center,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                style: const TextStyle(
                  fontSize: 32,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 12,
                ),
                decoration: InputDecoration(
                  labelText: '6-digit code',
                  counterText: '',
                  hintText: '——————',
                  hintStyle: TextStyle(
                      color: Colors.grey[300],
                      fontSize: 32,
                      letterSpacing: 12),
                  border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12)),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: const BorderSide(
                        color: Color(0xFF2196F3), width: 2),
                  ),
                ),
                onChanged: (_) {
                  if (_error != null) setState(() => _error = null);
                },
              ),
              const SizedBox(height: 28),

              // Verify button
              SizedBox(
                height: 54,
                child: ElevatedButton.icon(
                  onPressed: _loading ? null : _verifyOtp,
                  icon: _loading
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white))
                      : const Icon(Icons.verified_outlined),
                  label: Text(
                    _loading ? 'Verifying…' : 'Verify & Continue',
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.bold),
                  ),
                ),
              ),
              const SizedBox(height: 20),

              // Resend
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text("Didn't receive it? ",
                      style: TextStyle(color: Colors.grey[600])),
                  _resendLoading
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child:
                              CircularProgressIndicator(strokeWidth: 2))
                      : TextButton(
                          onPressed: _resend,
                          child: const Text('Resend Code'),
                        ),
                ],
              ),

              const SizedBox(height: 8),
              Text(
                'Step 1 of 2 — Email verification',
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: Colors.grey[500]),
              ),

              const SizedBox(height: 16),
              // Tip
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.blue.withValues(alpha: 0.06),
                  borderRadius: BorderRadius.circular(8),
                  border:
                      Border.all(color: Colors.blue.withValues(alpha: 0.2)),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.info_outline,
                        size: 16, color: Color(0xFF2196F3)),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Check your spam/junk folder if you don\'t see it in your inbox. The code is valid for 15 minutes.',
                        style: TextStyle(
                            fontSize: 12, color: Colors.grey[600]),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
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
        style:
            TextStyle(color: isError ? Colors.red : Colors.green[700]),
      ),
    );
  }
}
