import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../utils/error_helper.dart';

class ResetPasswordScreen extends StatefulWidget {
  final String token;
  const ResetPasswordScreen({super.key, required this.token});

  @override
  State<ResetPasswordScreen> createState() => _ResetPasswordScreenState();
}

class _ResetPasswordScreenState extends State<ResetPasswordScreen> {
  final _formKey = GlobalKey<FormState>();
  final passwordController = TextEditingController();
  final confirmController = TextEditingController();
  bool isLoading = false;
  bool done = false;
  bool _obscurePassword = true;
  bool _obscureConfirm = true;
  String? errorMessage;

  @override
  void dispose() {
    passwordController.dispose();
    confirmController.dispose();
    super.dispose();
  }

  Future<void> _handleReset() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() { isLoading = true; errorMessage = null; });
    try {
      await ApiService().resetPassword(
        token: widget.token,
        newPassword: passwordController.text,
      );
      if (mounted) setState(() { done = true; isLoading = false; });
    } catch (e) {
      if (mounted) setState(() { errorMessage = friendlyError(e); isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Set New Password'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/login'),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: done ? _successView() : _formView(),
        ),
      ),
    );
  }

  Widget _successView() {
    return Column(
      children: [
        const SizedBox(height: 60),
        Container(
          width: 80, height: 80,
          decoration: BoxDecoration(
            color: Colors.green.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(40),
          ),
          child: const Icon(Icons.check_circle_outline, size: 48, color: Colors.green),
        ),
        const SizedBox(height: 24),
        Text(
          'Password Updated!',
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 12),
        Text(
          'Your password has been reset successfully. You can now log in with your new password.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
        ),
        const SizedBox(height: 32),
        SizedBox(
          width: double.infinity,
          height: 56,
          child: ElevatedButton(
            onPressed: () => context.go('/login'),
            child: const Text('Go to Login', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          ),
        ),
      ],
    );
  }

  Widget _formView() {
    return Form(
      key: _formKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 40),
          const Icon(Icons.lock_outline, size: 64, color: Color(0xFF2196F3)),
          const SizedBox(height: 16),
          Text(
            'New Password',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineMedium?.copyWith(
              fontWeight: FontWeight.bold, color: const Color(0xFF2196F3),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Choose a strong password for your account.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
          ),
          const SizedBox(height: 32),
          if (errorMessage != null) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.red.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.red),
              ),
              child: Text(errorMessage!, style: const TextStyle(color: Colors.red)),
            ),
            const SizedBox(height: 16),
          ],
          TextFormField(
            controller: passwordController,
            obscureText: _obscurePassword,
            decoration: InputDecoration(
              labelText: 'New Password',
              prefixIcon: const Icon(Icons.lock_outline),
              suffixIcon: IconButton(
                icon: Icon(_obscurePassword ? Icons.visibility_off : Icons.visibility),
                onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
              ),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: Color(0xFF2196F3), width: 2),
              ),
            ),
            validator: (v) {
              if (v == null || v.isEmpty) return 'Required';
              if (v.length < 8) return 'Minimum 8 characters';
              if (!RegExp(r'[A-Z]').hasMatch(v)) return 'Must contain at least 1 uppercase letter';
              if (!RegExp(r'[0-9]').hasMatch(v)) return 'Must contain at least 1 number';
              if (!RegExp(r'[^A-Za-z0-9]').hasMatch(v)) return 'Must contain at least 1 special character';
              return null;
            },
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: confirmController,
            obscureText: _obscureConfirm,
            decoration: InputDecoration(
              labelText: 'Confirm Password',
              prefixIcon: const Icon(Icons.lock),
              suffixIcon: IconButton(
                icon: Icon(_obscureConfirm ? Icons.visibility_off : Icons.visibility),
                onPressed: () => setState(() => _obscureConfirm = !_obscureConfirm),
              ),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: Color(0xFF2196F3), width: 2),
              ),
            ),
            validator: (v) {
              if (v == null || v.isEmpty) return 'Required';
              if (v != passwordController.text) return 'Passwords do not match';
              return null;
            },
          ),
          const SizedBox(height: 24),
          SizedBox(
            height: 56,
            child: ElevatedButton(
              onPressed: isLoading ? null : _handleReset,
              child: isLoading
                  ? const SizedBox(
                      height: 24, width: 24,
                      child: CircularProgressIndicator(strokeWidth: 2, valueColor: AlwaysStoppedAnimation(Colors.white)),
                    )
                  : const Text('Set New Password', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            ),
          ),
        ],
      ),
    );
  }
}
