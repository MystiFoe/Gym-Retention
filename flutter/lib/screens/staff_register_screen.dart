import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
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
  // Step 1 = enter invite code, Step 2 = fill details
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

  @override
  void dispose() {
    _codeController.dispose();
    _nameController.dispose();
    _emailController.dispose();
    _phoneController.dispose();
    _passwordController.dispose();
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

  Future<void> _register() async {
    setState(() {
      _nameError     = AppUtils.validateName(_nameController.text);
      _emailError    = AppUtils.validateEmail(_emailController.text);
      _phoneError    = AppUtils.validatePhoneNumber(_phoneController.text);
      _passwordError = AppUtils.validatePassword(_passwordController.text);
    });
    if (_nameError != null || _emailError != null || _phoneError != null || _passwordError != null) return;

    setState(() { _loading = true; _error = null; });
    try {
      final isMember = _inviteInfo?.type == 'member';
      if (isMember) {
        await ApiService().memberSelfRegister(
          code:     _codeController.text.trim().toUpperCase(),
          name:     _nameController.text.trim(),
          email:    _emailController.text.trim(),
          phone:    _phoneController.text.trim(),
          password: _passwordController.text,
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
      setState(() { _error = e.toString().replaceFirst('Exception: ', ''); _loading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Staff Registration'),
        leading: BackButton(onPressed: () {
          if (_step == 2) {
            setState(() { _step = 1; _inviteInfo = null; _error = null; });
          } else {
            context.go(RoutePaths.login);
          }
        }),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: _step == 1 ? _buildCodeStep() : _buildDetailsStep(),
        ),
      ),
    );
  }

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
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.red.shade50,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.red.shade200),
            ),
            child: Text(_error!, style: TextStyle(color: Colors.red.shade700, fontSize: 13)),
          ),
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
        Text('Set your own credentials — your manager won\'t see your password.',
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
          decoration: InputDecoration(
            labelText: 'Phone *',
            prefixIcon: const Icon(Icons.phone),
            errorText: _phoneError,
            border: const OutlineInputBorder(),
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
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.red.shade50,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.red.shade200),
            ),
            child: Text(_error!, style: TextStyle(color: Colors.red.shade700, fontSize: 13)),
          ),
        ],
        const SizedBox(height: 24),
        ElevatedButton(
          onPressed: _loading ? null : _register,
          child: _loading
              ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Text('Create Account & Login'),
        ),
      ],
    );
  }
}
