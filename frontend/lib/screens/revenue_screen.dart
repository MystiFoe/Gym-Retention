import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../models/models.dart';

class RevenueScreen extends StatefulWidget {
  const RevenueScreen({super.key});

  @override
  State<RevenueScreen> createState() => _RevenueScreenState();
}

class _RevenueScreenState extends State<RevenueScreen> {
  late Future<RevenueResponse> revenueFuture;

  @override
  void initState() {
    super.initState();
    revenueFuture = ApiService().getRevenue();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Revenue'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/owner/dashboard'),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await ApiService().logout();
              if (!mounted) return;
              context.go('/login');
            },
          ),
        ],
      ),
      body: FutureBuilder<RevenueResponse>(
        future: revenueFuture,
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
                  Text('Error: ${snapshot.error}'),
                  const SizedBox(height: 12),
                  ElevatedButton(
                    onPressed: () => setState(() { revenueFuture = ApiService().getRevenue(); }),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            );
          }

          final response = snapshot.data!;
          final metrics = response.metrics;

          return RefreshIndicator(
            onRefresh: () async => setState(() { revenueFuture = ApiService().getRevenue(); }),
            child: SingleChildScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // 3 KPI Cards row
                  Row(
                    children: [
                      Expanded(
                        child: _KPICard(
                          title: 'Members\nRecovered',
                          value: '${metrics?.totalRecoveredMembers ?? 0}',
                          icon: Icons.people,
                          color: Colors.blue,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _KPICard(
                          title: 'This Month',
                          value: '₹${_formatAmount(metrics?.revenueThisMonth ?? 0)}',
                          icon: Icons.calendar_today,
                          color: Colors.green,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _KPICard(
                          title: 'This Year',
                          value: '₹${_formatAmount(metrics?.revenueThisYear ?? 0)}',
                          icon: Icons.trending_up,
                          color: Colors.purple,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  // Total card
                  Card(
                    elevation: 2,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    color: Colors.green[50],
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Row(
                        children: [
                          Container(
                            width: 48,
                            height: 48,
                            decoration: BoxDecoration(
                              color: Colors.green.withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: const Icon(Icons.savings, color: Colors.green, size: 26),
                          ),
                          const SizedBox(width: 16),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Total Revenue Saved',
                                  style: TextStyle(color: Colors.grey[600], fontSize: 13)),
                              Text(
                                '₹${_formatAmount(metrics?.totalRevenueRecovered ?? 0)}',
                                style: const TextStyle(
                                    fontSize: 24, fontWeight: FontWeight.bold, color: Colors.green),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),

                  // Member-level table
                  Text(
                    'Renewal Records',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 12),
                  if (response.revenueRecords.isEmpty)
                    Center(
                      child: Column(
                        children: [
                          const SizedBox(height: 32),
                          Icon(Icons.receipt_long, size: 64, color: Colors.grey[300]),
                          const SizedBox(height: 16),
                          Text('No revenue records yet',
                              style: Theme.of(context).textTheme.titleMedium?.copyWith(color: Colors.grey)),
                          const SizedBox(height: 8),
                          Text('Complete tasks with "Renewed" outcome to track revenue',
                              style: Theme.of(context).textTheme.bodySmall,
                              textAlign: TextAlign.center),
                        ],
                      ),
                    )
                  else
                    Card(
                      elevation: 1,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      child: Column(
                        children: [
                          // Table header
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                            decoration: BoxDecoration(
                              color: Colors.grey[100],
                              borderRadius: const BorderRadius.only(
                                topLeft: Radius.circular(12),
                                topRight: Radius.circular(12),
                              ),
                            ),
                            child: Row(
                              children: [
                                Expanded(flex: 3, child: Text('Member', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.grey[700], fontSize: 12))),
                                Expanded(flex: 2, child: Text('Date', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.grey[700], fontSize: 12))),
                                Expanded(flex: 2, child: Text('Amount', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.grey[700], fontSize: 12), textAlign: TextAlign.right)),
                              ],
                            ),
                          ),
                          const Divider(height: 1),
                          ListView.separated(
                            shrinkWrap: true,
                            physics: const NeverScrollableScrollPhysics(),
                            itemCount: response.revenueRecords.length,
                            separatorBuilder: (_, __) => const Divider(height: 1),
                            itemBuilder: (context, index) {
                              final rec = response.revenueRecords[index];
                              return Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                                child: Row(
                                  children: [
                                    Expanded(
                                      flex: 3,
                                      child: Row(
                                        children: [
                                          CircleAvatar(
                                            radius: 14,
                                            backgroundColor: Colors.green[100],
                                            child: Text(
                                              rec.memberName.isNotEmpty ? rec.memberName[0].toUpperCase() : '?',
                                              style: const TextStyle(color: Colors.green, fontSize: 12, fontWeight: FontWeight.bold),
                                            ),
                                          ),
                                          const SizedBox(width: 8),
                                          Flexible(
                                            child: Text(rec.memberName,
                                                style: const TextStyle(fontWeight: FontWeight.w500),
                                                overflow: TextOverflow.ellipsis),
                                          ),
                                        ],
                                      ),
                                    ),
                                    Expanded(
                                      flex: 2,
                                      child: Text(
                                        _formatDate(rec.trackedAt),
                                        style: TextStyle(color: Colors.grey[600], fontSize: 12),
                                      ),
                                    ),
                                    Expanded(
                                      flex: 2,
                                      child: Text(
                                        '₹${_formatAmount(rec.revenueRecovered)}',
                                        style: const TextStyle(
                                            color: Colors.green,
                                            fontWeight: FontWeight.bold),
                                        textAlign: TextAlign.right,
                                      ),
                                    ),
                                  ],
                                ),
                              );
                            },
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  String _formatAmount(double amount) {
    if (amount >= 100000) {
      return '${(amount / 100000).toStringAsFixed(2)}L';
    } else if (amount >= 1000) {
      final parts = amount.toStringAsFixed(0).split('');
      // Add thousand separator
      final result = StringBuffer();
      for (int i = 0; i < parts.length; i++) {
        if (i > 0 && (parts.length - i) % 3 == 0) result.write(',');
        result.write(parts[i]);
      }
      return result.toString();
    }
    return amount.toStringAsFixed(0);
  }

  String _formatDate(DateTime dt) {
    return '${dt.day.toString().padLeft(2, '0')}-${dt.month.toString().padLeft(2, '0')}-${dt.year}';
  }
}

class _KPICard extends StatelessWidget {
  final String title;
  final String value;
  final IconData icon;
  final Color color;

  const _KPICard({
    required this.title,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(icon, color: color, size: 20),
            ),
            const SizedBox(height: 8),
            Text(value,
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: color)),
            const SizedBox(height: 4),
            Text(title,
                style: Theme.of(context).textTheme.bodySmall,
                textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
