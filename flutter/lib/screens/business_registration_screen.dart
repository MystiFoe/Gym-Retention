import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../utils/app_utils.dart';
import '../utils/error_helper.dart';

class GymRegistrationScreen extends StatefulWidget {
  const GymRegistrationScreen({super.key});

  @override
  State<GymRegistrationScreen> createState() => _GymRegistrationScreenState();
}

class _GymRegistrationScreenState extends State<GymRegistrationScreen> {
  final _formKey = GlobalKey<FormState>();
  final businessNameController = TextEditingController();
  final ownerNameController    = TextEditingController();
  final phoneController        = TextEditingController();
  final emailController        = TextEditingController();
  final addressController      = TextEditingController();
  final ownerEmailController   = TextEditingController();
  final passwordController     = TextEditingController();
  final confirmPasswordController = TextEditingController();

  // Live error state per field
  String? _gymNameError;
  String? _ownerNameError;
  String? _phoneError;
  String? _gymEmailError;
  String? _addressError;
  String? _ownerEmailError;
  String? _passwordError;
  String? _confirmPasswordError;

  bool isLoading = false;
  String? errorMessage;
  bool _obscurePassword = true;
  bool _obscureConfirm  = true;

  @override
  void dispose() {
    businessNameController.dispose();
    ownerNameController.dispose();
    phoneController.dispose();
    emailController.dispose();
    addressController.dispose();
    ownerEmailController.dispose();
    passwordController.dispose();
    confirmPasswordController.dispose();
    super.dispose();
  }

  Future<void> _handleRegister() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      isLoading    = true;
      errorMessage = null;
    });

    try {
      final ownerEmail    = ownerEmailController.text.trim();
      final ownerPassword = passwordController.text;

      // 1. Create pending registration on backend
      final result = await ApiService().registerBusiness(
        businessName:  businessNameController.text.trim(),
        ownerName:     ownerNameController.text.trim(),
        phone:         phoneController.text.trim(),
        email:         emailController.text.trim(),
        address:       addressController.text.trim(),
        ownerEmail:    ownerEmail,
        ownerPassword: ownerPassword,
      );

      if (!mounted) return;
      context.push(
        '/register/verify-email',
        extra: {
          'pendingId':  result.pendingId,
          'ownerEmail': result.ownerEmail,
        },
      );
    } catch (e) {
      if (mounted) {
        setState(() {
          errorMessage = friendlyError(e);
          isLoading    = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 40),
                Container(
                  width: 80,
                  height: 80,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: const Color(0xFF2196F3).withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Icon(
                    Icons.fitness_center,
                    size: 50,
                    color: Color(0xFF2196F3),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  'Register Your Business',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: const Color(0xFF2196F3),
                  ),
                ),
                Text(
                  'Start your 30-day free trial',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Colors.grey[600],
                  ),
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
                    child: Text(
                      errorMessage!,
                      style: const TextStyle(color: Colors.red),
                    ),
                  ),
                  const SizedBox(height: 16),
                ],

                // ── Gym Details ────────────────────────────────────────────
                Text(
                  'Business Details',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 12),

                TextFormField(
                  autovalidateMode: AutovalidateMode.onUserInteraction,
                  controller: businessNameController,
                  decoration: InputDecoration(
                    labelText: 'Business Name *',
                    prefixIcon: const Icon(Icons.store),
                    errorText: _gymNameError,
                  ),
                  validator: (v) => AppUtils.validateName(v),
                  onChanged: (v) => setState(() => _gymNameError = AppUtils.validateName(v)),
                ),
                const SizedBox(height: 16),

                TextFormField(
                  autovalidateMode: AutovalidateMode.onUserInteraction,
                  controller: phoneController,
                  keyboardType: TextInputType.phone,
                  decoration: InputDecoration(
                    labelText: 'Business Phone *',
                    prefixIcon: const Icon(Icons.phone),
                    errorText: _phoneError,
                  ),
                  validator: (v) => AppUtils.validatePhoneNumber(v),
                  onChanged: (v) => setState(() => _phoneError = AppUtils.validatePhoneNumber(v)),
                ),
                const SizedBox(height: 16),

                TextFormField(
                  autovalidateMode: AutovalidateMode.onUserInteraction,
                  controller: emailController,
                  keyboardType: TextInputType.emailAddress,
                  decoration: InputDecoration(
                    labelText: 'Business Email *',
                    prefixIcon: const Icon(Icons.email_outlined),
                    errorText: _gymEmailError,
                  ),
                  validator: (v) => AppUtils.validateEmail(v),
                  onChanged: (v) => setState(() => _gymEmailError = AppUtils.validateEmail(v)),
                ),
                const SizedBox(height: 16),

                TextFormField(
                  autovalidateMode: AutovalidateMode.onUserInteraction,
                  controller: addressController,
                  decoration: InputDecoration(
                    labelText: 'Business Address *',
                    prefixIcon: const Icon(Icons.location_on_outlined),
                    errorText: _addressError,
                  ),
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) return 'Address is required';
                    return null;
                  },
                  onChanged: (v) => setState(() {
                    _addressError = (v.trim().isEmpty) ? 'Address is required' : null;
                  }),
                ),
                const SizedBox(height: 24),

                // ── Owner Details ──────────────────────────────────────────
                Text(
                  'Owner Details',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 12),

                TextFormField(
                  autovalidateMode: AutovalidateMode.onUserInteraction,
                  controller: ownerNameController,
                  decoration: InputDecoration(
                    labelText: 'Owner Name *',
                    prefixIcon: const Icon(Icons.person_outline),
                    errorText: _ownerNameError,
                  ),
                  validator: (v) => AppUtils.validateName(v),
                  onChanged: (v) => setState(() => _ownerNameError = AppUtils.validateName(v)),
                ),
                const SizedBox(height: 16),

                TextFormField(
                  autovalidateMode: AutovalidateMode.onUserInteraction,
                  controller: ownerEmailController,
                  keyboardType: TextInputType.emailAddress,
                  decoration: InputDecoration(
                    labelText: 'Owner Login Email *',
                    prefixIcon: const Icon(Icons.email),
                    errorText: _ownerEmailError,
                  ),
                  validator: (v) => AppUtils.validateEmail(v),
                  onChanged: (v) => setState(() => _ownerEmailError = AppUtils.validateEmail(v)),
                ),
                const SizedBox(height: 16),

                TextFormField(
                  autovalidateMode: AutovalidateMode.onUserInteraction,
                  controller: passwordController,
                  obscureText: _obscurePassword,
                  decoration: InputDecoration(
                    labelText: 'Password *',
                    prefixIcon: const Icon(Icons.lock_outline),
                    errorText: _passwordError,
                    suffixIcon: IconButton(
                      icon: Icon(_obscurePassword ? Icons.visibility_off : Icons.visibility),
                      onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                    ),
                  ),
                  validator: (v) => AppUtils.validatePassword(v ?? ''),
                  onChanged: (v) {
                    setState(() {
                      _passwordError = AppUtils.validatePassword(v);
                      // re-validate confirm if it already has text
                      if (confirmPasswordController.text.isNotEmpty) {
                        _confirmPasswordError = confirmPasswordController.text != v
                            ? 'Passwords do not match'
                            : null;
                      }
                    });
                  },
                ),
                const SizedBox(height: 16),

                TextFormField(
                  autovalidateMode: AutovalidateMode.onUserInteraction,
                  controller: confirmPasswordController,
                  obscureText: _obscureConfirm,
                  decoration: InputDecoration(
                    labelText: 'Confirm Password *',
                    prefixIcon: const Icon(Icons.lock),
                    errorText: _confirmPasswordError,
                    suffixIcon: IconButton(
                      icon: Icon(_obscureConfirm ? Icons.visibility_off : Icons.visibility),
                      onPressed: () => setState(() => _obscureConfirm = !_obscureConfirm),
                    ),
                  ),
                  validator: (v) {
                    if (v == null || v.isEmpty) return 'Please confirm your password';
                    if (v != passwordController.text) return 'Passwords do not match';
                    return null;
                  },
                  onChanged: (v) => setState(() {
                    _confirmPasswordError = (v != passwordController.text)
                        ? 'Passwords do not match'
                        : null;
                  }),
                ),
                const SizedBox(height: 32),

                SizedBox(
                  height: 56,
                  child: ElevatedButton(
                    onPressed: isLoading ? null : _handleRegister,
                    child: isLoading
                        ? const SizedBox(
                            height: 24,
                            width: 24,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                            ),
                          )
                        : const Text(
                            'Register Business',
                            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                          ),
                  ),
                ),
                const SizedBox(height: 20),

                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      'Already registered? ',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    GestureDetector(
                      onTap: () => context.go('/login'),
                      child: Text(
                        'Login',
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: const Color(0xFF2196F3),
                          fontWeight: FontWeight.bold,
                          decoration: TextDecoration.underline,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 24),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
