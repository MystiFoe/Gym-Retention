import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../services/firebase_service.dart';
import '../models/models.dart';
import '../utils/app_utils.dart';
import '../utils/app_routes.dart';
import '../main.dart';
import 'package:shared_preferences/shared_preferences.dart';

class StaffRegisterScreen extends StatefulWidget {
  const StaffRegisterScreen({super.key});

  @override
  State<StaffRegisterScreen> createState() => _StaffRegisterScreenState();
}

class _StaffRegisterScreenState extends State<StaffRegisterScreen> {
  // Step 1 = invite code, Step 2 = fill details, Step 3 = phone OTP, Step 4 = email OTP
  int _step = 1;

  final _codeController     = TextEditingController();
  final _nameController     = TextEditingController();
  final _emailController    = TextEditingController();
  final _phoneController    = TextEditingController();
  final _passwordController = TextEditingController();

  InviteCodeInfo? _inviteInfo;
  bool _obscurePassword = true;
  bool _loading = false;
  String? _error;

  String? _codeError;
  String? _nameError;
  String? _emailError;
  String? _phoneError;
  String? _passwordError;

  // Phone OTP state
  String? _verificationId;
  String? _firebaseIdToken;
  final _phoneOtpController = TextEditingController();
  bool _phoneSending = false;
  bool _phoneVerifying = false;
  String? _phoneOtpError;

  // Email OTP state
  String? _emailTempKey;
  final _emailOtpController = TextEditingController();
  bool _emailSending = false;
  bool _emailVerifying = false;
  String? _emailOtpError;
  String? _emailOtpSuccess;

  @override
  void dispose() {
    _codeController.dispose();
    _nameController.dispose();
    _emailController.dispose();
    _phoneController.dispose();
    _passwordController.dispose();
    _phoneOtpController.dispose();
    _emailOtpController.dispose();
    super.dispose();
  }

  Future<void> _validateCode() async {
    final code = _codeController.text.trim().toUpperCase();
    if (code.isEmpty) {
      setState(() => _codeError = 'Enter your invite code');
      return;
    }
    setState(() { _loading = true; _codeError = null; _error = null; });
    try {
      final info = await ApiService().validateInviteCode(code);
      setState(() {
        _inviteInfo = info;
        _step = 2;
        _loading = false;
        if (info.placeholderName != null && info.placeholderName!.isNotEmpty) {
          _nameController.text = info.placeholderName!;
        }
      });
    } catch (e) {
      setState(() { _error = e.toString().replaceFirst('Exception: ', ''); _loading = false; });
    }
  }

  Future<void> _goToPhoneVerification() async {
    setState(() {
      _nameError     = AppUtils.validateName(_nameController.text);
      _emailError    = AppUtils.validateEmail(_emailController.text);
      _phoneError    = AppUtils.validatePhoneNumber(_phoneController.text);
      _passwordError = AppUtils.validatePassword(_passwordController.text);
    });
    if (_nameError != null || _emailError != null || _phoneError != null || _passwordError != null) return;
    setState(() { _step = 3; _phoneOtpError = null; _verificationId = null; _firebaseIdToken = null; });
    await _sendPhoneOtp();
  }

  Future<void> _sendPhoneOtp() async {
    final phone = _phoneController.text.trim();
    final e164 = phone.startsWith('+') ? phone : '+91$phone';
    setState(() { _phoneSending = true; _phoneOtpError = null; });
    try {
      final result = await FirebaseService().sendOtp(e164);
      if (!mounted) return;
      if (result.autoVerified && result.idToken != null) {
        setState(() { _firebaseIdToken = result.idToken; _phoneSending = false; });
        await _afterPhoneVerified();
      } else {
        setState(() { _verificationId = result.verificationId; _phoneSending = false; });
      }
    } on FirebaseAuthException catch (e) {
      if (mounted) setState(() { _phoneSending = false; _phoneOtpError = _friendlyFirebaseError(e); });
    } catch (_) {
      if (mounted) setState(() { _phoneSending = false; _phoneOtpError = 'Failed to send OTP. Check number and try again.'; });
    }
  }

  Future<void> _verifyPhoneCode() async {
    final code = _phoneOtpController.text.trim();
    if (code.length != 6) { setState(() => _phoneOtpError = 'Enter the 6-digit code'); return; }
    if (_verificationId == null) return;
    setState(() { _phoneVerifying = true; _phoneOtpError = null; });
    try {
      final token = await FirebaseService().verifyOtp(verificationId: _verificationId!, smsCode: code);
      if (!mounted) return;
      setState(() { _firebaseIdToken = token; _phoneVerifying = false; });
      await _afterPhoneVerified();
    } on FirebaseAuthException catch (e) {
      if (mounted) setState(() { _phoneVerifying = false; _phoneOtpError = _friendlyFirebaseError(e); });
    } catch (e) {
      if (mounted) setState(() { _phoneVerifying = false; _phoneOtpError = e.toString().replaceFirst('Exception: ', ''); });
    }
  }

  Future<void> _afterPhoneVerified() async {
    // Move to email OTP step and send OTP
    setState(() { _step = 4; _emailOtpError = null; _emailTempKey = null; });
    await _sendEmailOtp();
  }

  Future<void> _sendEmailOtp() async {
    setState(() { _emailSending = true; _emailOtpError = null; _emailOtpSuccess = null; });
    try {
      final result = await ApiService().memberSendEmailOtp(
        code: _codeController.text.trim().toUpperCase(),
        email: _emailController.text.trim(),
      );
      if (!mounted) return;
      setState(() { _emailTempKey = result['tempKey'] as String?; _emailSending = false; _emailOtpSuccess = 'OTP sent to ${_emailController.text.trim()}'; });
    } catch (e) {
      if (mounted) setState(() { _emailSending = false; _emailOtpError = e.toString().replaceFirst('Exception: ', ''); });
    }
  }

  Future<void> _verifyEmailAndRegister() async {
    final otp = _emailOtpController.text.trim();
    if (otp.length != 6) { setState(() => _emailOtpError = 'Enter the 6-digit code'); return; }
    setState(() { _emailVerifying = true; _emailOtpError = null; });
    try {
      await _register(emailOtpKey: _emailTempKey, emailOtp: otp, firebaseIdToken: _firebaseIdToken);
    } catch (e) {
      if (mounted) setState(() { _emailVerifying = false; _emailOtpError = e.toString().replaceFirst('Exception: ', ''); });
    }
  }

  Future<void> _register({String? emailOtpKey, String? emailOtp, String? firebaseIdToken}) async {
    setState(() { _loading = true; _error = null; });
    try {
      final isMember = _inviteInfo?.type == 'member';
      if (isMember) {
        await ApiService().memberSelfRegister(
          code:            _codeController.text.trim().toUpperCase(),
          name:            _nameController.text.trim(),
          email:           _emailController.text.trim(),
          phone:           _phoneController.text.trim(),
          password:        _passwordController.text,
          emailOtpKey:     emailOtpKey,
          emailOtp:        emailOtp,
          firebaseIdToken: firebaseIdToken,
        );
        if (!mounted) return;
        authNotifier.update(true, role: 'member');
        context.go(RoutePaths.memberDashboard);
      } else {
        await ApiService().staffSelfRegister(
          code:     _codeController.text.trim().toUpperCase(),
          name:     _nameController.text.trim(),
          email:    _emailController.text.trim(),
          phone:    _phoneController.text.trim(),
          password: _passwordController.text,
        );
        if (!mounted) return;
        final prefs = await SharedPreferences.getInstance();
        final role        = prefs.getString('user_role')    ?? 'trainer';
        final trainerRole = prefs.getString('trainer_role') ?? 'staff';
        authNotifier.update(true, role: role, trainerRole: trainerRole);
        final destination = trainerRole == 'admin'
            ? RoutePaths.ownerDashboard
            : RoutePaths.trainerDashboard;
        if (!mounted) return;
        context.go(destination);
      }
    } catch (e) {
      setState(() { _error = e.toString().replaceFirst('Exception: ', ''); _loading = false; _emailVerifying = false; });
    }
  }

  String _friendlyFirebaseError(FirebaseAuthException e) {
    switch (e.code) {
      case 'invalid-phone-number':       return 'Invalid phone number. Include country code (e.g. +91).';
      case 'too-many-requests':          return 'Too many attempts. Please try again later.';
      case 'invalid-verification-code':  return 'Wrong code. Please check and try again.';
      case 'session-expired':            return 'OTP expired. Tap Resend.';
      case 'quota-exceeded':             return 'SMS quota exceeded. Try again later.';
      default: return e.message ?? 'An error occurred. Please try again.';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_appBarTitle),
        leading: BackButton(onPressed: _onBack),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: _buildCurrentStep(),
        ),
      ),
    );
  }

  String get _appBarTitle {
    switch (_step) {
      case 1: return 'Register with Code';
      case 2: return 'Create Account';
      case 3: return 'Verify Phone';
      case 4: return 'Verify Email';
      default: return 'Register';
    }
  }

  void _onBack() {
    if (_step == 4) {
      setState(() { _step = 3; _emailOtpController.clear(); _emailOtpError = null; });
    } else if (_step == 3) {
      setState(() { _step = 2; _phoneOtpController.clear(); _phoneOtpError = null; });
    } else if (_step == 2) {
      setState(() { _step = 1; _inviteInfo = null; _error = null; });
    } else {
      context.go(RoutePaths.login);
    }
  }

  Widget _buildCurrentStep() {
    switch (_step) {
      case 1: return _buildCodeStep();
      case 2: return _buildDetailsStep();
      case 3: return _buildPhoneOtpStep();
      case 4: return _buildEmailOtpStep();
      default: return _buildCodeStep();
    }
  }

  // ── Step 1: Invite Code ───────────────────────────────────────────────────

  Widget _buildCodeStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 16),
        const Icon(Icons.badge_outlined, size: 64, color: Color(0xFF2196F3)),
        const SizedBox(height: 16),
        Text('Enter Invite Code',
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold),
            textAlign: TextAlign.center),
        const SizedBox(height: 8),
        Text('Enter the 8-character code shared by your gym.',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey),
            textAlign: TextAlign.center),
        const SizedBox(height: 32),
        TextFormField(
          controller: _codeController,
          textCapitalization: TextCapitalization.characters,
          style: const TextStyle(letterSpacing: 4, fontSize: 20, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
          maxLength: 8,
          decoration: InputDecoration(
            labelText: 'Invite Code',
            hintText: 'XXXXXXXX',
            errorText: _codeError,
            counterText: '',
            border: const OutlineInputBorder(),
          ),
          onChanged: (_) => setState(() => _codeError = null),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          _errorBox(_error!),
        ],
        const SizedBox(height: 24),
        ElevatedButton(
          onPressed: _loading ? null : _validateCode,
          child: _loading
              ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Text('Continue'),
        ),
        const SizedBox(height: 16),
        TextButton(
          onPressed: () => context.go(RoutePaths.login),
          child: const Text('Already registered? Login'),
        ),
      ],
    );
  }

  // ── Step 2: Details ───────────────────────────────────────────────────────

  Widget _buildDetailsStep() {
    final info = _inviteInfo!;
    final isMember = info.type == 'member';
    final isAdmin  = info.trainerRole == 'admin';
    final chipColor = isMember ? Colors.green : (isAdmin ? Colors.purple : Colors.blue);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: chipColor.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: chipColor.withValues(alpha: 0.4)),
          ),
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(isMember ? Icons.fitness_center : (isAdmin ? Icons.admin_panel_settings : Icons.badge),
                      color: chipColor),
                  const SizedBox(width: 8),
                  Text(
                    isMember ? 'Member Invite' : (isAdmin ? 'Admin Invite' : 'Staff Invite'),
                    style: TextStyle(fontWeight: FontWeight.bold, color: chipColor),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(info.gymName,
                  style: const TextStyle(fontSize: 13, color: Colors.black87),
                  textAlign: TextAlign.center),
              const SizedBox(height: 4),
              Text('Your ID: ${info.displayId}',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
            ],
          ),
        ),
        const SizedBox(height: 24),
        Text('Create Your Account',
            style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        Text('Your phone and email will be verified in the next steps.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey)),
        const SizedBox(height: 20),
        TextFormField(
          controller: _nameController,
          decoration: InputDecoration(
            labelText: 'Full Name *',
            prefixIcon: const Icon(Icons.person),
            errorText: _nameError,
            border: const OutlineInputBorder(),
          ),
          onChanged: (v) => setState(() => _nameError = AppUtils.validateName(v)),
        ),
        const SizedBox(height: 14),
        TextFormField(
          controller: _emailController,
          keyboardType: TextInputType.emailAddress,
          decoration: InputDecoration(
            labelText: 'Email (used to login) *',
            prefixIcon: const Icon(Icons.email),
            errorText: _emailError,
            border: const OutlineInputBorder(),
          ),
          onChanged: (v) => setState(() => _emailError = AppUtils.validateEmail(v)),
        ),
        const SizedBox(height: 14),
        TextFormField(
          controller: _phoneController,
          keyboardType: TextInputType.phone,
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+]'))],
          decoration: InputDecoration(
            labelText: 'Phone *',
            prefixIcon: const Icon(Icons.phone),
            hintText: '+91 98765 43210',
            errorText: _phoneError,
            border: const OutlineInputBorder(),
            helperText: 'Include country code, e.g. +91',
          ),
          onChanged: (v) => setState(() => _phoneError = AppUtils.validatePhoneNumber(v)),
        ),
        const SizedBox(height: 14),
        TextFormField(
          controller: _passwordController,
          obscureText: _obscurePassword,
          decoration: InputDecoration(
            labelText: 'Password *',
            prefixIcon: const Icon(Icons.lock),
            errorText: _passwordError,
            border: const OutlineInputBorder(),
            suffixIcon: IconButton(
              icon: Icon(_obscurePassword ? Icons.visibility_off : Icons.visibility),
              onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
            ),
          ),
          onChanged: (v) => setState(() => _passwordError = AppUtils.validatePassword(v)),
        ),
        const SizedBox(height: 6),
        Text('Min 8 chars • 1 uppercase • 1 number • 1 special character',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey)),
        if (_error != null) ...[
          const SizedBox(height: 12),
          _errorBox(_error!),
        ],
        const SizedBox(height: 24),
        // Staff can skip OTP (they register less often and may have limited SMS)
        if (isMember)
          ElevatedButton.icon(
            onPressed: _loading ? null : _goToPhoneVerification,
            icon: _loading
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.verified_user),
            label: const Text('Verify & Create Account'),
          )
        else
          ElevatedButton(
            onPressed: _loading ? null : () => _register(),
            child: _loading
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Create Account & Login'),
          ),
      ],
    );
  }

  // ── Step 3: Phone OTP ─────────────────────────────────────────────────────

  Widget _buildPhoneOtpStep() {
    final phone = _phoneController.text.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 24),
        const Icon(Icons.phone_android, size: 72, color: Color(0xFF2196F3)),
        const SizedBox(height: 20),
        Text('Verify Your Phone',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold, color: const Color(0xFF2196F3))),
        const SizedBox(height: 8),
        Text(
          _verificationId == null && !_phoneSending
              ? 'Sending OTP to $phone…'
              : _phoneSending
                  ? 'Sending OTP to $phone…'
                  : 'Enter the 6-digit code sent to $phone',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
        ),
        const SizedBox(height: 32),
        if (_phoneOtpError != null) ...[
          _errorBox(_phoneOtpError!),
          const SizedBox(height: 16),
        ],
        if (_phoneSending)
          const Center(child: CircularProgressIndicator())
        else if (_verificationId != null) ...[
          TextField(
            controller: _phoneOtpController,
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
          const SizedBox(height: 24),
          ElevatedButton.icon(
            onPressed: _phoneVerifying ? null : _verifyPhoneCode,
            icon: _phoneVerifying
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.verified),
            label: Text(_phoneVerifying ? 'Verifying…' : 'Verify Phone',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text("Didn't receive it? ", style: TextStyle(color: Colors.grey[600])),
              TextButton(
                onPressed: _phoneSending ? null : () {
                  setState(() { _phoneOtpController.clear(); _phoneOtpError = null; _verificationId = null; });
                  _sendPhoneOtp();
                },
                child: const Text('Resend OTP'),
              ),
            ],
          ),
        ],
      ],
    );
  }

  // ── Step 4: Email OTP ─────────────────────────────────────────────────────

  Widget _buildEmailOtpStep() {
    final email = _emailController.text.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 24),
        const Icon(Icons.mark_email_unread_outlined, size: 72, color: Color(0xFF2196F3)),
        const SizedBox(height: 20),
        Text('Verify Your Email',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold, color: const Color(0xFF2196F3))),
        const SizedBox(height: 8),
        Text('Enter the 6-digit code sent to $email',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600])),
        const SizedBox(height: 32),
        if (_emailOtpError != null) ...[
          _errorBox(_emailOtpError!),
          const SizedBox(height: 12),
        ],
        if (_emailOtpSuccess != null) ...[
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.green.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.green),
            ),
            child: Text(_emailOtpSuccess!, style: const TextStyle(color: Colors.green)),
          ),
          const SizedBox(height: 12),
        ],
        if (_emailSending)
          const Center(child: CircularProgressIndicator())
        else ...[
          TextField(
            controller: _emailOtpController,
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
            onChanged: (_) => setState(() => _emailOtpError = null),
          ),
          const SizedBox(height: 24),
          ElevatedButton.icon(
            onPressed: _emailVerifying ? null : _verifyEmailAndRegister,
            icon: _emailVerifying
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.check_circle),
            label: Text(_emailVerifying ? 'Creating account…' : 'Verify & Create Account',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text("Didn't receive it? ", style: TextStyle(color: Colors.grey[600])),
              TextButton(
                onPressed: _emailSending ? null : () {
                  setState(() { _emailOtpController.clear(); _emailOtpError = null; _emailOtpSuccess = null; });
                  _sendEmailOtp();
                },
                child: const Text('Resend Code'),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Step 2 of 2 — Email verification',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey[500]),
          ),
          const SizedBox(height: 12),
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
                    'Check your spam folder if you don\'t see it. Code is valid for 15 minutes.',
                    style: TextStyle(fontSize: 12, color: Colors.grey[600]),
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  Widget _errorBox(String message) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Colors.red.shade50,
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: Colors.red.shade200),
    ),
    child: Text(message, style: TextStyle(color: Colors.red.shade700, fontSize: 13)),
  );
}
