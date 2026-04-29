import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import '../services/api_service.dart';
import '../models/models.dart';
import '../utils/web_redirect.dart';

class AdminScreen extends StatefulWidget {
  const AdminScreen({super.key});

  @override
  State<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends State<AdminScreen> {
  final _secretController = TextEditingController();
  bool _authenticated = false;
  bool _loading = false;
  List<AdminBusiness> _gyms = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    if (kIsWeb) {
      // On web, the standalone HTML admin page is always more reliable.
      // Redirect immediately so /#/admin and /#/admin.html both work.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        redirectToUrl('/admin');
      });
    }
  }

  Future<void> _login() async {
    final secret = _secretController.text.trim();
    if (secret.isEmpty) return;
    setState(() { _loading = true; _error = null; });
    try {
      final gyms = await ApiService().adminGetBusinesses(secret);
      setState(() { _gyms = gyms; _authenticated = true; _loading = false; });
    } catch (e) {
      setState(() { _error = e.toString(); _loading = false; });
    }
  }

  Future<void> _refresh() async {
    setState(() { _loading = true; _error = null; });
    try {
      final gyms = await ApiService().adminGetBusinesses(_secretController.text.trim());
      setState(() { _gyms = gyms; _loading = false; });
    } catch (e) {
      setState(() { _error = e.toString(); _loading = false; });
    }
  }

  Future<void> _suspend(AdminBusiness gym) async {
    final confirm = await _confirmDialog('Suspend "${gym.name}"?',
        'This will block all logins for this business.');
    if (!confirm) return;
    try {
      await ApiService().adminSuspendBusiness(_secretController.text.trim(), gym.id);
      _refresh();
    } catch (e) {
      _showError(e.toString());
    }
  }

  Future<void> _reactivate(AdminBusiness gym) async {
    final confirm = await _confirmDialog('Reactivate "${gym.name}"?',
        'This will restore access to this business.');
    if (!confirm) return;
    try {
      await ApiService().adminReactivateBusiness(_secretController.text.trim(), gym.id);
      _refresh();
    } catch (e) {
      _showError(e.toString());
    }
  }

  Future<void> _delete(AdminBusiness gym) async {
    // Two-step confirmation for destructive action
    final step1 = await _confirmDialog(
      'Delete "${gym.name}"?',
      'This will permanently delete the business and ALL its data — customers, staff, tasks, revenue. This cannot be undone.',
    );
    if (!step1 || !mounted) return;
    final step2 = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Final Confirmation'),
        content: Text('Type the business name to confirm deletion.\n\nYou are about to delete: ${gym.name}'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('DELETE PERMANENTLY', style: TextStyle(color: Colors.red, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
    if (step2 != true) return;
    try {
      await ApiService().adminDeleteBusiness(_secretController.text.trim(), gym.id);
      _refresh();
    } catch (e) {
      _showError(e.toString());
    }
  }

  Future<void> _convert(AdminBusiness gym) async {
    int months = 1;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setS) => AlertDialog(
          title: Text('Activate Subscription — ${gym.name}'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Select subscription duration:'),
              const SizedBox(height: 16),
              DropdownButton<int>(
                value: months,
                isExpanded: true,
                items: const [
                  DropdownMenuItem(value: 1, child: Text('1 Month')),
                  DropdownMenuItem(value: 3, child: Text('3 Months')),
                  DropdownMenuItem(value: 6, child: Text('6 Months')),
                  DropdownMenuItem(value: 12, child: Text('12 Months')),
                ],
                onChanged: (v) => setS(() => months = v!),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            ElevatedButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Activate')),
          ],
        ),
      ),
    );
    if (confirmed != true) return;
    try {
      await ApiService().adminConvertBusiness(_secretController.text.trim(), gym.id, months);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Subscription activated for ${gym.name} ($months month(s))'),
          backgroundColor: Colors.green,
        ));
      }
      _refresh();
    } catch (e) {
      _showError(e.toString());
    }
  }

  Future<bool> _confirmDialog(String title, String message) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Confirm')),
        ],
      ),
    );
    return result ?? false;
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Admin Panel'),
        actions: _authenticated
            ? [
                IconButton(icon: const Icon(Icons.refresh), onPressed: _loading ? null : _refresh),
                IconButton(
                  icon: const Icon(Icons.logout),
                  onPressed: () => setState(() { _authenticated = false; _gyms = []; }),
                ),
              ]
            : null,
      ),
      body: _authenticated ? _buildGymList() : _buildLoginForm(),
    );
  }

  Widget _buildLoginForm() {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 400),
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.admin_panel_settings, size: 64, color: Color(0xFF2196F3)),
              const SizedBox(height: 24),
              const Text('Admin Access',
                  style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
              const SizedBox(height: 32),
              TextField(
                controller: _secretController,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: 'Admin Secret',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.lock),
                ),
                onSubmitted: (_) => _login(),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: const TextStyle(color: Colors.red)),
              ],
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: ElevatedButton(
                  onPressed: _loading ? null : _login,
                  child: _loading
                      ? const SizedBox(height: 20, width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Sign In', style: TextStyle(fontSize: 16)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildGymList() {
    if (_loading && _gyms.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    // Summary stats
    final total = _gyms.length;
    final active = _gyms.where((g) => g.subscriptionStatus == 'active').length;
    final trial = _gyms.where((g) => g.subscriptionStatus == 'trial').length;
    final suspended = _gyms.where((g) => g.subscriptionStatus == 'suspended').length;

    return RefreshIndicator(
      onRefresh: _refresh,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Summary row
            Row(
              children: [
                _StatChip(label: 'Total', value: total, color: Colors.blue),
                const SizedBox(width: 8),
                _StatChip(label: 'Active', value: active, color: Colors.green),
                const SizedBox(width: 8),
                _StatChip(label: 'Trial', value: trial, color: Colors.orange),
                const SizedBox(width: 8),
                _StatChip(label: 'Suspended', value: suspended, color: Colors.red),
              ],
            ),
            const SizedBox(height: 16),
            ..._gyms.map((gym) => _GymCard(
              gym: gym,
              onSuspend: () => _suspend(gym),
              onReactivate: () => _reactivate(gym),
              onConvert: () => _convert(gym),
              onDelete: () => _delete(gym),
            )),
          ],
        ),
      ),
    );
  }
}

class _StatChip extends StatelessWidget {
  final String label;
  final int value;
  final Color color;
  const _StatChip({required this.label, required this.value, required this.color});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: color.withValues(alpha: 0.3)),
        ),
        child: Column(
          children: [
            Text('$value', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18, color: color)),
            Text(label, style: TextStyle(fontSize: 11, color: color)),
          ],
        ),
      ),
    );
  }
}

class _GymCard extends StatelessWidget {
  final AdminBusiness gym;
  final VoidCallback onSuspend;
  final VoidCallback onReactivate;
  final VoidCallback onConvert;
  final VoidCallback onDelete;

  const _GymCard({
    required this.gym,
    required this.onSuspend,
    required this.onReactivate,
    required this.onConvert,
    required this.onDelete,
  });

  Color get _statusColor {
    switch (gym.subscriptionStatus) {
      case 'active': return Colors.green;
      case 'trial': return gym.daysRemaining <= 3 ? Colors.red : Colors.orange;
      case 'suspended': return Colors.red;
      case 'expired': return Colors.grey;
      default: return Colors.grey;
    }
  }

  String get _statusLabel {
    switch (gym.subscriptionStatus) {
      case 'active': return 'Active';
      case 'trial': return gym.daysRemaining > 0 ? 'Trial (${gym.daysRemaining}d left)' : 'Trial Expired';
      case 'suspended': return 'Suspended';
      case 'expired': return 'Expired';
      default: return gym.subscriptionStatus;
    }
  }

  @override
  Widget build(BuildContext context) {
    final isSuspended = gym.subscriptionStatus == 'suspended';
    final isActive = gym.subscriptionStatus == 'active';
    final joinDate = '${gym.createdAt.day}/${gym.createdAt.month}/${gym.createdAt.year}';

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(gym.name,
                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                      const SizedBox(height: 2),
                      Text(gym.ownerName,
                          style: const TextStyle(color: Colors.grey, fontSize: 13)),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: _statusColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: _statusColor.withValues(alpha: 0.4)),
                  ),
                  child: Text(_statusLabel,
                      style: TextStyle(color: _statusColor, fontWeight: FontWeight.w600, fontSize: 12)),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 16,
              runSpacing: 4,
              children: [
                _InfoItem(icon: Icons.email, text: gym.email),
                _InfoItem(icon: Icons.phone, text: gym.phone),
                _InfoItem(icon: Icons.people, text: '${gym.customerCount} customers'),
                _InfoItem(icon: Icons.calendar_today, text: 'Joined $joinDate'),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                if (!isActive)
                  _ActionButton(
                    label: 'Activate',
                    icon: Icons.check_circle_outline,
                    color: Colors.green,
                    onTap: onConvert,
                  ),
                if (!isActive) const SizedBox(width: 8),
                if (!isSuspended)
                  _ActionButton(
                    label: 'Suspend',
                    icon: Icons.block,
                    color: Colors.red,
                    onTap: onSuspend,
                  ),
                if (isSuspended)
                  _ActionButton(
                    label: 'Reactivate',
                    icon: Icons.restore,
                    color: Colors.blue,
                    onTap: onReactivate,
                  ),
                const Spacer(),
                _ActionButton(
                  label: 'Delete',
                  icon: Icons.delete_forever,
                  color: Colors.red[900]!,
                  onTap: onDelete,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _InfoItem extends StatelessWidget {
  final IconData icon;
  final String text;
  const _InfoItem({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: Colors.grey),
        const SizedBox(width: 4),
        Text(text, style: const TextStyle(fontSize: 12, color: Colors.grey)),
      ],
    );
  }
}

class _ActionButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color color;
  final VoidCallback onTap;
  const _ActionButton({required this.label, required this.icon, required this.color, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onTap,
      icon: Icon(icon, size: 16, color: color),
      label: Text(label, style: TextStyle(color: color, fontSize: 13)),
      style: OutlinedButton.styleFrom(
        side: BorderSide(color: color.withValues(alpha: 0.5)),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        minimumSize: Size.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
    );
  }
}
