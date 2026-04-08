import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../models/models.dart';

class MemberDashboardScreen extends StatefulWidget {
  const MemberDashboardScreen({super.key});

  @override
  State<MemberDashboardScreen> createState() => _MemberDashboardScreenState();
}

class _MemberDashboardScreenState extends State<MemberDashboardScreen> {
  late Future<MembersResponse> memberFuture;

  @override
  void initState() {
    super.initState();
    memberFuture = ApiService().getMembers(limit: 1);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('My Profile'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await ApiService().logout();
              if (mounted) context.go('/login');
            },
          ),
        ],
      ),
      body: FutureBuilder<MembersResponse>(
        future: memberFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          if (snapshot.hasError) {
            final err = snapshot.error.toString().toLowerCase();
            if (err.contains('session') || err.contains('unauthorized') || err.contains('token') || err.contains('401')) {
              WidgetsBinding.instance.addPostFrameCallback((_) => context.go('/login'));
              return const Center(child: CircularProgressIndicator());
            }
            return Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.error_outline, size: 48, color: Colors.red),
                  const SizedBox(height: 12),
                  Text('Could not load profile: ${snapshot.error}'),
                  const SizedBox(height: 12),
                  ElevatedButton(
                    onPressed: () => setState(() { memberFuture = ApiService().getMembers(limit: 1); }),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            );
          }

          final members = snapshot.data?.members ?? [];
          if (members.isEmpty) {
            return const Center(child: Text('No member profile found'));
          }

          final member = members.first;
          final statusColor = _getStatusColor(member.status);

          return SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Profile card
                Card(
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      children: [
                        CircleAvatar(
                          radius: 40,
                          backgroundColor: const Color(0xFF2196F3).withValues(alpha: 0.15),
                          child: Text(
                            member.name[0].toUpperCase(),
                            style: const TextStyle(
                                fontSize: 32,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF2196F3)),
                          ),
                        ),
                        const SizedBox(height: 16),
                        Text(
                          member.name,
                          style: Theme.of(context)
                              .textTheme
                              .headlineSmall
                              ?.copyWith(fontWeight: FontWeight.bold),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          member.phone,
                          style: Theme.of(context)
                              .textTheme
                              .bodyMedium
                              ?.copyWith(color: Colors.grey),
                        ),
                        if (member.email.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(
                            member.email,
                            style: Theme.of(context)
                                .textTheme
                                .bodyMedium
                                ?.copyWith(color: Colors.grey),
                          ),
                        ],
                        const SizedBox(height: 12),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                          decoration: BoxDecoration(
                            color: statusColor.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text(
                            member.statusDisplay,
                            style: TextStyle(color: statusColor, fontWeight: FontWeight.bold),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 24),
                Text(
                  'Membership Details',
                  style: Theme.of(context)
                      .textTheme
                      .titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 12),
                _DetailCard(
                  icon: Icons.access_time,
                  title: 'Days Until Expiry',
                  value: member.daysUntilExpiry > 0
                      ? '${member.daysUntilExpiry} days'
                      : 'Expired',
                  color: member.daysUntilExpiry <= 7 ? Colors.red : Colors.orange,
                ),
                const SizedBox(height: 12),
                _DetailCard(
                  icon: Icons.fitness_center,
                  title: 'Last Visit',
                  value: member.lastVisitDate != null
                      ? '${member.daysSinceLastVisit} days ago'
                      : 'Never visited',
                  color: Colors.blue,
                ),
                const SizedBox(height: 12),
                _DetailCard(
                  icon: Icons.calendar_month,
                  title: 'Expiry Date',
                  value: member.membershipExpiryDate.toString().split(' ')[0],
                  color: Colors.teal,
                ),
                const SizedBox(height: 12),
                _DetailCard(
                  icon: Icons.currency_rupee,
                  title: 'Plan Fee',
                  value: '₹${member.planFee.toStringAsFixed(0)}',
                  color: Colors.purple,
                ),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: ElevatedButton.icon(
                    icon: const Icon(Icons.refresh),
                    label: const Text('Request Renewal',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                    onPressed: () {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('Renewal request sent to gym owner'),
                          backgroundColor: Colors.green,
                        ),
                      );
                    },
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Color _getStatusColor(String status) {
    switch (status) {
      case 'active': return const Color(0xFF4CAF50);
      case 'at_risk': return const Color(0xFFFF9800);
      case 'high_risk': return const Color(0xFFF44336);
      default: return Colors.grey;
    }
  }
}

class _DetailCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String value;
  final Color color;

  const _DetailCard({
    required this.icon,
    required this.title,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: color, size: 24),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall
                          ?.copyWith(color: Colors.grey)),
                  const SizedBox(height: 4),
                  Text(value,
                      style: Theme.of(context)
                          .textTheme
                          .titleMedium
                          ?.copyWith(fontWeight: FontWeight.bold)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
