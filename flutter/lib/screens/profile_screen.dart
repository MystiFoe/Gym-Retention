import 'package:flutter/material.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';
import 'package:gym_fitness_app/utils/appui_helper.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../main.dart';
import '../models/models.dart';
import '../services/api_service.dart';
import '../services/firebase_service.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late Future<UserProfile> _profileFuture;

  @override
  void initState() {
    super.initState();
    _profileFuture = ApiService().getProfile();
  }

  void _reload() => setState(() => _profileFuture = ApiService().getProfile());

  Future<void> _logout() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Logout'),
        content: const Text('Are you sure you want to logout?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red, foregroundColor: Colors.white),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Logout'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await ApiService().logout();
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    authNotifier.update(false, role: '');
    if (!mounted) return;
    AppRoutes.pushAndRemoveUntil(RouteNames.login);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.grey[100],
      appBar: AppBar(
        title: const Text('Profile'),
        elevation: 0,
      ),
      body: FutureBuilder<UserProfile>(
        future: _profileFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(child: Text('Error: ${snapshot.error}'));
          }
          final profile = snapshot.data!;
          final isOwner = profile.role == 'owner';
          return SingleChildScrollView(
            child: Column(
              children: [
                // ── Header ──────────────────────────────────────────
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 32),
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      colors: [Color(0xFF1976D2), Color(0xFF42A5F5)],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                  ),
                  child: Column(
                    children: [
                      CircleAvatar(
                        radius: 40,
                        backgroundColor: Colors.white.withValues(alpha: 0.3),
                        child: Text(
                          profile.name.isNotEmpty ? profile.name[0].toUpperCase() : '?',
                          style: const TextStyle(
                            fontSize: 36,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        profile.name,
                        style: const TextStyle(
                          fontSize: 22,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.25),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(
                          isOwner ? 'Owner' : 'Staff',
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w600,
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 20),

                // ── Profile Details ──────────────────────────────────
                _SectionCard(
                  title: 'Profile Details',
                  trailing: TextButton.icon(
                    onPressed: () => _showEditProfileSheet(profile),
                    icon: const Icon(Icons.edit, size: 16),
                    label: const Text('Edit'),
                  ),
                  children: [
                    _InfoRow(icon: Icons.person, label: 'Name', value: profile.name),
                    _InfoRow(icon: Icons.email, label: 'Email', value: profile.email.isEmpty ? '—' : profile.email),
                    // Phone row with verification badge
                    Row(
                      children: [
                        Expanded(
                          child: _InfoRow(
                            icon: Icons.phone,
                            label: 'Phone',
                            value: profile.phone.isEmpty ? '—' : profile.phone,
                          ),
                        ),
                        if (profile.phone.isNotEmpty && !profile.phoneVerified)
                          _PhoneVerifyBadge(
                            phone: profile.phone,
                            onVerified: _reload,
                          ),
                        if (profile.phone.isNotEmpty && profile.phoneVerified)
                          const Padding(
                            padding: EdgeInsets.only(right: 8),
                            child: Icon(Icons.verified, color: Colors.green, size: 18),
                          ),
                      ],
                    ),
                  ],
                ),

                // ── Business Details (owner only) ─────────────────────────
                if (isOwner && profile.gym != null) ...[
                  const SizedBox(height: 12),
                  _SectionCard(
                    title: 'Business Details',
                    trailing: TextButton.icon(
                      onPressed: () => _showEditGymSheet(profile.gym!),
                      icon: const Icon(Icons.edit, size: 16),
                      label: const Text('Edit'),
                    ),
                    children: [
                      _InfoRow(icon: Icons.store, label: 'Business Name', value: profile.gym!.name),
                      _InfoRow(icon: Icons.phone, label: 'Phone', value: profile.gym!.phone.isEmpty ? '—' : profile.gym!.phone),
                      _InfoRow(icon: Icons.email, label: 'Email', value: profile.gym!.email.isEmpty ? '—' : profile.gym!.email),
                      _InfoRow(icon: Icons.location_on, label: 'Address', value: profile.gym!.address.isEmpty ? '—' : profile.gym!.address),
                    ],
                  ),
                ],

                const SizedBox(height: 12),

                // ── Change Password ──────────────────────────────────
                _SectionCard(
                  title: 'Security',
                  children: [
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.lock_outline, color: Colors.blueAccent),
                      title: const Text('Change Password'),
                      trailing: const Icon(Icons.arrow_forward_ios, size: 14),
                      onTap: () => _showChangePasswordSheet(profile.name),
                    ),
                  ],
                ),

                const SizedBox(height: 24),

                // ── Logout ───────────────────────────────────────────
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: SizedBox(
                    width: double.infinity,
                    height: 50,
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.red,
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      icon: const Icon(Icons.logout),
                      label: const Text('Logout', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                      onPressed: _logout,
                    ),
                  ),
                ),
                const SizedBox(height: 32),
              ],
            ),
          );
        },
      ),
    );
  }

  // ── Edit Profile Sheet ──────────────────────────────────────────────────────
  void _showEditProfileSheet(UserProfile profile) {
    final nameCtrl  = TextEditingController(text: profile.name);
    final phoneCtrl = TextEditingController(text: profile.phone);
    final emailCtrl = TextEditingController(text: profile.email);
    final formKey   = GlobalKey<FormState>();
    bool submitting = false;

    showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 20, right: 20, top: 24,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
        ),
        child: StatefulBuilder(
          builder: (ctx, setSheet) => Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Edit Profile', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                const SizedBox(height: 20),
                TextFormField(
                  controller: nameCtrl,
                  decoration: const InputDecoration(labelText: 'Name *', prefixIcon: Icon(Icons.person)),
                  validator: (v) => (v == null || v.trim().length < 2) ? 'Name must be at least 2 characters' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: emailCtrl,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: 'Email *', prefixIcon: Icon(Icons.email)),
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) return 'Email is required';
                    if (!RegExp(r'^[\w.]+@[\w]+\.\w{2,}$').hasMatch(v.trim())) return 'Enter a valid email';
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: phoneCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(
                    labelText: 'Phone',
                    prefixIcon: Icon(Icons.phone),
                    helperText: 'Changing phone requires OTP verification',
                  ),
                ),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: ElevatedButton(
                    onPressed: submitting ? null : () async {
                      if (!formKey.currentState!.validate()) return;
                      setSheet(() => submitting = true);
                      try {
                        await ApiService().updateProfile(
                          name: nameCtrl.text.trim(),
                          phone: phoneCtrl.text.trim(),
                          email: emailCtrl.text.trim(),
                        );
                        if (!ctx.mounted) return;
                        Navigator.pop(ctx, true);
                      } catch (e) {
                        if (!ctx.mounted) return;
                        setSheet(() => submitting = false);
                        ScaffoldMessenger.of(ctx).showSnackBar(
                          SnackBar(content: Text(e.toString()), backgroundColor: Colors.red),
                        );
                      }
                    },
                    child: submitting
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Text('Save Changes'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ).then((result) {
      if (result == true) {
        _reload();
        if (!mounted) return;
        AppUiHelper().showModernSnackBar(context, message: 'Profile updated successfully');
      }
    });
  }

  // ── Edit Gym Sheet (owner only) ─────────────────────────────────────────────
  void _showEditGymSheet(GymProfile gym) {
    final nameCtrl    = TextEditingController(text: gym.name);
    final phoneCtrl   = TextEditingController(text: gym.phone);
    final addressCtrl = TextEditingController(text: gym.address);
    final formKey     = GlobalKey<FormState>();
    bool submitting   = false;

    showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 20, right: 20, top: 24,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
        ),
        child: StatefulBuilder(
          builder: (ctx, setSheet) => Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Edit Business Details', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                const SizedBox(height: 20),
                TextFormField(
                  controller: nameCtrl,
                  decoration: const InputDecoration(labelText: 'Business Name *', prefixIcon: Icon(Icons.store)),
                  validator: (v) => (v == null || v.trim().length < 2) ? 'Business name must be at least 2 characters' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: phoneCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Phone', prefixIcon: Icon(Icons.phone)),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: addressCtrl,
                  maxLines: 2,
                  decoration: const InputDecoration(labelText: 'Address', prefixIcon: Icon(Icons.location_on)),
                ),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: ElevatedButton(
                    onPressed: submitting ? null : () async {
                      if (!formKey.currentState!.validate()) return;
                      setSheet(() => submitting = true);
                      try {
                        await ApiService().updateGym(
                          gymName: nameCtrl.text.trim(),
                          phone: phoneCtrl.text.trim(),
                          address: addressCtrl.text.trim(),
                        );
                        if (!ctx.mounted) return;
                        Navigator.pop(ctx, true);
                      } catch (e) {
                        if (!ctx.mounted) return;
                        setSheet(() => submitting = false);
                        ScaffoldMessenger.of(ctx).showSnackBar(
                          SnackBar(content: Text(e.toString()), backgroundColor: Colors.red),
                        );
                      }
                    },
                    child: submitting
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Text('Save Changes'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ).then((result) {
      if (result == true) {
        _reload();
        if (!mounted) return;
        AppUiHelper().showModernSnackBar(context, message: 'Business details updated successfully');
      }
    });
  }

  // ── Change Password Sheet ───────────────────────────────────────────────────
  void _showChangePasswordSheet(String currentName) {
    final currentCtrl = TextEditingController();
    final newCtrl     = TextEditingController();
    final confirmCtrl = TextEditingController();
    final formKey     = GlobalKey<FormState>();
    bool submitting   = false;

    showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 20, right: 20, top: 24,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
        ),
        child: StatefulBuilder(
          builder: (ctx, setSheet) => Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Change Password', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                const SizedBox(height: 20),
                TextFormField(
                  controller: currentCtrl,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Current Password *', prefixIcon: Icon(Icons.lock_outline)),
                  validator: (v) => (v == null || v.isEmpty) ? 'Enter current password' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: newCtrl,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'New Password *', prefixIcon: Icon(Icons.lock)),
                  validator: (v) => (v == null || v.length < 6) ? 'Password must be at least 6 characters' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: confirmCtrl,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Confirm New Password *', prefixIcon: Icon(Icons.lock)),
                  validator: (v) => v != newCtrl.text ? 'Passwords do not match' : null,
                ),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: ElevatedButton(
                    onPressed: submitting ? null : () async {
                      if (!formKey.currentState!.validate()) return;
                      setSheet(() => submitting = true);
                      try {
                        await ApiService().updateProfile(
                          name: currentName,
                          currentPassword: currentCtrl.text,
                          newPassword: newCtrl.text,
                        );
                        if (!ctx.mounted) return;
                        Navigator.pop(ctx, true);
                      } catch (e) {
                        if (!ctx.mounted) return;
                        setSheet(() => submitting = false);
                        ScaffoldMessenger.of(ctx).showSnackBar(
                          SnackBar(content: Text(e.toString()), backgroundColor: Colors.red),
                        );
                      }
                    },
                    child: submitting
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Text('Change Password'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ).then((result) {
      if (result == true) {
        if (!mounted) return;
        AppUiHelper().showModernSnackBar(context, message: 'Password changed successfully');
      }
    });
  }
}

// ── Reusable widgets ────────────────────────────────────────────────────────

class _SectionCard extends StatelessWidget {
  final String title;
  final List<Widget> children;
  final Widget? trailing;

  const _SectionCard({required this.title, required this.children, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Card(
        elevation: 1,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                  ?trailing,
                ],
              ),
              const Divider(height: 20),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _InfoRow({required this.icon, required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Icon(icon, size: 18, color: Colors.blueAccent),
          const SizedBox(width: 12),
          SizedBox(
            width: 72,
            child: Text(label, style: TextStyle(color: Colors.grey[600], fontSize: 13)),
          ),
          Expanded(
            child: Text(value, style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14)),
          ),
        ],
      ),
    );
  }
}

// ── Phone verification badge ─────────────────────────────────────────────────
class _PhoneVerifyBadge extends StatefulWidget {
  final String phone;
  final VoidCallback onVerified;
  const _PhoneVerifyBadge({required this.phone, required this.onVerified});

  @override
  State<_PhoneVerifyBadge> createState() => _PhoneVerifyBadgeState();
}

class _PhoneVerifyBadgeState extends State<_PhoneVerifyBadge> {
  bool _loading = false;
  bool _verified = false;

  Future<void> _verify() async {
    setState(() => _loading = true);
    try {
      final phone = widget.phone.startsWith('+') ? widget.phone : '+91${widget.phone}';
      final result = await FirebaseService().sendOtp(phone);

      if (!mounted) return;

      if (result.autoVerified && result.idToken != null) {
        await ApiService().verifyProfilePhone(result.idToken!);
        if (mounted) setState(() => _verified = true);
        widget.onVerified();
        if (mounted) AppUiHelper().showModernSnackBar(context, message: 'Phone verified successfully');
        return;
      }

      // Manual OTP entry dialog
      final codeCtrl = TextEditingController();
      final confirmed = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: const Text('Verify Phone'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Enter the OTP sent to $phone'),
              const SizedBox(height: 16),
              TextField(
                controller: codeCtrl,
                keyboardType: TextInputType.number,
                maxLength: 6,
                autofocus: true,
                decoration: const InputDecoration(labelText: '6-digit OTP', counterText: ''),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Verify'),
            ),
          ],
        ),
      );

      if (confirmed != true || !mounted) return;

      final idToken = await FirebaseService().verifyOtp(
        verificationId: result.verificationId!,
        smsCode: codeCtrl.text.trim(),
      );
      await ApiService().verifyProfilePhone(idToken);
      if (mounted) setState(() => _verified = true);
      widget.onVerified();
      if (mounted) AppUiHelper().showModernSnackBar(context, message: 'Phone verified successfully');
    } catch (e) {
      if (mounted) AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_verified) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: _loading
          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
          : GestureDetector(
              onTap: _verify,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: Colors.red.shade50,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.red.shade300),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.error_outline, size: 12, color: Colors.red.shade700),
                    const SizedBox(width: 3),
                    Text('Verify', style: TextStyle(fontSize: 11, color: Colors.red.shade700, fontWeight: FontWeight.bold)),
                  ],
                ),
              ),
            ),
    );
  }
}
