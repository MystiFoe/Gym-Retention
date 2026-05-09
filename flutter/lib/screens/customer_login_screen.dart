import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../services/firebase_service.dart';
import '../utils/app_routes.dart';

enum _LoginMode { emailPassword, otpPhone, otpVerify }

class CustomerLoginScreen extends StatefulWidget {
  const CustomerLoginScreen({super.key});

  @override
  State<CustomerLoginScreen> createState() => _CustomerLoginScreenState();
}

class _CustomerLoginScreenState extends State<CustomerLoginScreen> {
  // Email + password
  final _emailCtrl    = TextEditingController();
  final _passwordCtrl = TextEditingController();
  bool _obscurePassword = true;

  // OTP
  final _phoneCtrl = TextEditingController();
  final _otpCtrl   = TextEditingController();
  String? _verificationId;

  _LoginMode _mode    = _LoginMode.emailPassword;
  bool       _loading = false;
  String?    _error;

  @override
  void dispose() {
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    _phoneCtrl.dispose();
    _otpCtrl.dispose();
    super.dispose();
  }

  // ── Email + Password ───────────────────────────────────────────────────────

  Future<void> _emailPasswordLogin() async {
    final email    = _emailCtrl.text.trim();
    final password = _passwordCtrl.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = 'Enter your email and password');
      return;
    }
    setState(() { _loading = true; _error = null; });
    try {
      await ApiService().memberEmailLogin(email: email, password: password);
      if (mounted) context.go(RoutePaths.memberDashboard);
    } catch (e) {
      setState(() {
        _error   = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  // ── Phone OTP ──────────────────────────────────────────────────────────────

  Future<void> _sendOtp() async {
    final raw = _phoneCtrl.text.trim();
    if (raw.length < 10) {
      setState(() => _error = 'Enter a valid 10-digit phone number');
      return;
    }
    final phone = raw.startsWith('+') ? raw : '+91$raw';
    setState(() { _loading = true; _error = null; });
    try {
      final result = await FirebaseService().sendOtp(phone);
      if (result.autoVerified && result.idToken != null) {
        await _loginWithToken(result.idToken!);
        return;
      }
      setState(() { _verificationId = result.verificationId; _loading = false; _mode = _LoginMode.otpVerify; });
    } catch (e) {
      setState(() { _error = e.toString().replaceFirst('Exception: ', ''); _loading = false; });
    }
  }

  Future<void> _verifyOtp() async {
    if (_otpCtrl.text.trim().length != 6) {
      setState(() => _error = 'Enter the 6-digit OTP');
      return;
    }
    setState(() { _loading = true; _error = null; });
    try {
      final idToken = await FirebaseService().verifyOtp(
        verificationId: _verificationId!,
        smsCode: _otpCtrl.text.trim(),
      );
      await _loginWithToken(idToken);
    } catch (e) {
      setState(() { _error = 'Invalid OTP. Please try again.'; _loading = false; });
    }
  }

  Future<void> _loginWithToken(String idToken) async {
    try {
      final resp = await ApiService().customerLogin(idToken);
      if (resp.multiple) {
        if (!mounted) return;
        final chosen = await _pickGym(resp.gyms, resp.firebaseIdToken!);
        if (chosen == null) { setState(() => _loading = false); return; }
        final final2 = await ApiService().customerSelectGym(resp.firebaseIdToken!, chosen);
        await ApiService().saveCustomerSession(final2);
      } else {
        await ApiService().saveCustomerSession(resp);
      }
      if (mounted) context.go(RoutePaths.memberDashboard);
    } catch (e) {
      final msg = e.toString().replaceFirst('Exception: ', '');
      if (msg.contains('No gym membership') || msg.contains('not found') || msg.contains('404')) {
        setState(() { _loading = false; _error = null; });
        _showInviteLinkDialog(idToken);
      } else {
        setState(() { _error = msg; _loading = false; });
      }
    }
  }

  void _showInviteLinkDialog(String firebaseToken) {
    final codeCtrl = TextEditingController();
    bool loading   = false;
    String? error;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDs) => AlertDialog(
          title: const Text('Enter Invite Code'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Your number is not linked to any gym. Enter the invite code provided by your gym.',
                style: TextStyle(fontSize: 13, color: Colors.grey),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: codeCtrl,
                textCapitalization: TextCapitalization.characters,
                maxLength: 8,
                style: const TextStyle(letterSpacing: 4, fontWeight: FontWeight.bold, fontSize: 18),
                textAlign: TextAlign.center,
                decoration: const InputDecoration(
                  labelText: 'Invite Code',
                  hintText: 'XXXXXXXX',
                  counterText: '',
                  border: OutlineInputBorder(),
                ),
              ),
              if (error != null) ...[
                const SizedBox(height: 10),
                Text(error!, style: const TextStyle(color: Colors.red, fontSize: 13)),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: () {
                Navigator.pop(ctx);
                setState(() => _error = 'No gym membership found. Contact your gym to be added.');
              },
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: loading
                  ? null
                  : () async {
                      if (codeCtrl.text.trim().length < 6) {
                        setDs(() => error = 'Enter a valid invite code');
                        return;
                      }
                      setDs(() { loading = true; error = null; });
                      try {
                        final resp = await ApiService().memberLinkInvite(
                          firebaseIdToken: firebaseToken,
                          code:            codeCtrl.text.trim(),
                        );
                        await ApiService().saveCustomerSession(resp);
                        if (!ctx.mounted) return;
                        Navigator.pop(ctx);
                        if (mounted) context.go(RoutePaths.memberDashboard);
                      } catch (e) {
                        setDs(() { error = e.toString().replaceFirst('Exception: ', ''); loading = false; });
                      }
                    },
              child: loading
                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Link Account'),
            ),
          ],
        ),
      ),
    );
  }

  Future<String?> _pickGym(List<Map<String, String>> gyms, String token) async {
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Select Your Gym'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: gyms.map((g) => ListTile(
            title: Text(g['gym_name'] ?? ''),
            subtitle: Text(g['name'] ?? ''),
            onTap: () => Navigator.pop(ctx, g['member_id']),
          )).toList(),
        ),
      ),
    );
  }

  void _switchToOtp() {
    setState(() { _mode = _LoginMode.otpPhone; _error = null; _verificationId = null; _otpCtrl.clear(); });
  }

  void _switchToEmailPassword() {
    setState(() { _mode = _LoginMode.emailPassword; _error = null; _verificationId = null; _otpCtrl.clear(); });
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      appBar: AppBar(
        title: const Text('Member Login'),
        backgroundColor: const Color(0xFF2196F3),
        foregroundColor: Colors.white,
        elevation: 0,
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 24),
              // Avatar
              Center(
                child: Container(
                  width: 80, height: 80,
                  decoration: BoxDecoration(
                    color: const Color(0xFF2196F3).withValues(alpha: 0.12),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.person, size: 44, color: Color(0xFF2196F3)),
                ),
              ),
              const SizedBox(height: 20),
              Text(
                _mode == _LoginMode.emailPassword
                    ? 'Welcome Back'
                    : _mode == _LoginMode.otpPhone
                        ? 'Login with OTP'
                        : 'Enter OTP',
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 6),
              Text(
                _mode == _LoginMode.emailPassword
                    ? 'Sign in with your email and password'
                    : _mode == _LoginMode.otpPhone
                        ? 'Enter your registered phone number'
                        : 'Enter the 6-digit code sent to +91 ${_phoneCtrl.text.trim()}',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 28),

              // Error banner
              if (_error != null)
                Container(
                  padding: const EdgeInsets.all(12),
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: Colors.red.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: Colors.red.withValues(alpha: 0.4)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.error_outline, color: Colors.red, size: 18),
                      const SizedBox(width: 8),
                      Expanded(child: Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 13))),
                    ],
                  ),
                ),

              // ── Email + Password form ──────────────────────────────────────
              if (_mode == _LoginMode.emailPassword) ...[
                _buildTextField(
                  controller: _emailCtrl,
                  label: 'Email or Phone',
                  hint: 'you@example.com',
                  icon: Icons.email_outlined,
                  keyboardType: TextInputType.emailAddress,
                ),
                const SizedBox(height: 16),
                _buildTextField(
                  controller: _passwordCtrl,
                  label: 'Password',
                  hint: '••••••••',
                  icon: Icons.lock_outline,
                  obscure: _obscurePassword,
                  suffixIcon: IconButton(
                    icon: Icon(
                      _obscurePassword ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                      color: Colors.grey,
                    ),
                    onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                  ),
                  onSubmitted: (_) => _emailPasswordLogin(),
                ),
                const SizedBox(height: 28),
                _primaryButton(
                  label: 'Login',
                  onPressed: _emailPasswordLogin,
                ),
                const SizedBox(height: 20),
                const Row(children: [
                  Expanded(child: Divider()),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 12),
                    child: Text('or', style: TextStyle(color: Colors.grey)),
                  ),
                  Expanded(child: Divider()),
                ]),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: _loading ? null : _switchToOtp,
                  icon: const Icon(Icons.phone_android),
                  label: const Text('Login with OTP'),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    side: const BorderSide(color: Color(0xFF2196F3)),
                    foregroundColor: const Color(0xFF2196F3),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ],

              // ── Phone OTP — enter phone ────────────────────────────────────
              if (_mode == _LoginMode.otpPhone) ...[
                _buildTextField(
                  controller: _phoneCtrl,
                  label: 'Phone Number',
                  hint: '9876543210',
                  icon: Icons.phone,
                  keyboardType: TextInputType.phone,
                  prefixText: '+91 ',
                  onSubmitted: (_) => _sendOtp(),
                ),
                const SizedBox(height: 28),
                _primaryButton(label: 'Send OTP', onPressed: _sendOtp),
                const SizedBox(height: 16),
                _backToEmailButton(),
              ],

              // ── Phone OTP — enter code ─────────────────────────────────────
              if (_mode == _LoginMode.otpVerify) ...[
                _buildTextField(
                  controller: _otpCtrl,
                  label: '6-digit OTP',
                  hint: '______',
                  icon: Icons.lock_outline,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  autofocus: true,
                  onSubmitted: (_) => _verifyOtp(),
                ),
                const SizedBox(height: 28),
                _primaryButton(label: 'Verify & Login', onPressed: _verifyOtp),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: _loading ? null : () => setState(() { _mode = _LoginMode.otpPhone; _otpCtrl.clear(); _error = null; }),
                  child: const Text('Change Phone Number'),
                ),
                const SizedBox(height: 4),
                _backToEmailButton(),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTextField({
    required TextEditingController controller,
    required String label,
    required String hint,
    required IconData icon,
    TextInputType keyboardType = TextInputType.text,
    bool obscure = false,
    Widget? suffixIcon,
    String? prefixText,
    int? maxLength,
    bool autofocus = false,
    ValueChanged<String>? onSubmitted,
  }) {
    return TextField(
      controller: controller,
      keyboardType: keyboardType,
      obscureText: obscure,
      maxLength: maxLength,
      autofocus: autofocus,
      onSubmitted: onSubmitted,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        prefixIcon: Icon(icon),
        prefixText: prefixText,
        suffixIcon: suffixIcon,
        counterText: '',
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: Colors.grey.shade200),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFF2196F3), width: 2),
        ),
      ),
    );
  }

  Widget _primaryButton({required String label, required VoidCallback onPressed}) {
    return SizedBox(
      height: 52,
      child: ElevatedButton(
        onPressed: _loading ? null : onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: const Color(0xFF2196F3),
          foregroundColor: Colors.white,
          disabledBackgroundColor: const Color(0xFF2196F3).withValues(alpha: 0.5),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          elevation: 2,
        ),
        child: _loading
            ? const SizedBox(width: 22, height: 22,
                child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
            : Text(label, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
      ),
    );
  }

  Widget _backToEmailButton() {
    return TextButton.icon(
      onPressed: _loading ? null : _switchToEmailPassword,
      icon: const Icon(Icons.arrow_back, size: 16),
      label: const Text('Back to Email Login'),
      style: TextButton.styleFrom(foregroundColor: Colors.grey[700]),
    );
  }
}
