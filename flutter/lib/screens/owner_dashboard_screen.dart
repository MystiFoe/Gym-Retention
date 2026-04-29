import 'dart:async';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../main.dart';
import '../services/api_service.dart';
import '../models/models.dart';
import 'profile_screen.dart';

class OwnerDashboardScreen extends StatefulWidget {
  final int refreshTrigger;
  const OwnerDashboardScreen({super.key, this.refreshTrigger = 0});

  @override
  State<OwnerDashboardScreen> createState() => _OwnerDashboardScreenState();
}

class _OwnerDashboardScreenState extends State<OwnerDashboardScreen>
    with WidgetsBindingObserver {
  late Future<DashboardKPIs> kpisFuture;
  int selectedIndex = 0;
  BusinessSubscriptionResponse? _subscription;
  String? _gymId;
  Timer? _subscriptionTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
    // Refresh subscription banner every 60 seconds so changes from admin reflect automatically
    _subscriptionTimer = Timer.periodic(const Duration(seconds: 60), (_) {
      if (mounted) _loadSubscription();
    });
  }

  @override
  void dispose() {
    _subscriptionTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  @override
  void didUpdateWidget(OwnerDashboardScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.refreshTrigger != oldWidget.refreshTrigger) _refresh();
  }

  void _refresh() {
    setState(() {
      kpisFuture = ApiService().getDashboardKPIs();
    });
    _loadSubscription();
  }

  Future<void> _loadSubscription() async {
    final prefs = await SharedPreferences.getInstance();
    _gymId = prefs.getString('gym_id');
    if (_gymId == null || !mounted) return;
    try {
      final sub = await ApiService().getBusinessSubscription(_gymId!);
      if (mounted) setState(() => _subscription = sub);
    } catch (_) {}
  }


  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Dashboard'),
        elevation: 0,
        actions: [
          IconButton(
            icon: const CircleAvatar(
              radius: 16,
              backgroundColor: Color(0xFF1976D2),
              child: Icon(Icons.person, size: 18, color: Colors.white),
            ),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => const ProfileScreen()),
            ),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: FutureBuilder<DashboardKPIs>(
        future: kpisFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          if (snapshot.hasError) {
            final err = snapshot.error.toString().toLowerCase();
            if (err.contains('session') || err.contains('unauthorized') || err.contains('token') || err.contains('401')) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                authNotifier.update(false, role: '');
                AppRoutes.pushAndRemoveUntil(RouteNames.login);
              });
              return const Center(child: CircularProgressIndicator());
            }
            return Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.wifi_off_rounded, size: 48, color: Colors.grey),
                  const SizedBox(height: 12),
                  const Text('Could not load dashboard', style: TextStyle(color: Colors.grey)),
                  const SizedBox(height: 16),
                  ElevatedButton.icon(
                    onPressed: _refresh,
                    icon: const Icon(Icons.refresh),
                    label: const Text('Retry'),
                  ),
                ],
              ),
            );
          }

          final kpis = snapshot.data!;

          return RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (_subscription != null) _SubscriptionBanner(sub: _subscription!, businessId: _gymId ?? ''),
                if (_subscription != null) const SizedBox(height: 16),
                Text(
                  'Welcome Back!',
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  "Here's your business performance",
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Colors.grey[600],
                  ),
                ),
                const SizedBox(height: 24),
                GridView.count(
                  crossAxisCount: 2,
                  mainAxisSpacing: 16,
                  crossAxisSpacing: 16,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  children: [
                    _KPICard(
                      title: 'Total Customers',
                      value: kpis.totalCustomers.toString(),
                      icon: Icons.people,
                      color: Colors.blue,
                    ),
                    _KPICard(
                      title: 'Active',
                      value: kpis.activeCustomers.toString(),
                      icon: Icons.check_circle,
                      color: Colors.green,
                    ),
                    _KPICard(
                      title: 'High Risk',
                      value: kpis.highRiskCustomers.toString(),
                      icon: Icons.warning,
                      color: Colors.red,
                    ),
                    _KPICard(
                      title: 'Revenue Saved',
                      value: '₹${kpis.revenueRecovered.toStringAsFixed(0)}',
                      icon: Icons.trending_up,
                      color: Colors.purple,
                    ),
                  ],
                ),
                const SizedBox(height: 32),
                Text(
                  'Quick Actions',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 16),
                _QuickActionButton(
                  icon: Icons.person_add,
                  title: 'Add Customer',
                  subtitle: 'Register new customer',
                  onTap: () async {
                    await AppRoutes.pushNamed(RouteNames.ownerMembers).then((_) {
                      setState(() {
                        kpisFuture = ApiService().getDashboardKPIs();
                      });
                    });
                  },
                ),
                const SizedBox(height: 12),
                _QuickActionButton(
                  icon: Icons.assignment,
                  title: 'Assign Tasks',
                  subtitle: 'Assign tasks to staff',
                  onTap: () async {
                    await AppRoutes.pushNamed(RouteNames.ownerTasks);

                    kpisFuture = ApiService().getDashboardKPIs();
                    setState(() {

                    });
                  }
                ),
                const SizedBox(height: 12),
                _QuickActionButton(
                  icon: Icons.trending_up,
                  title: 'View Revenue',
                  subtitle: 'Recovery metrics',
                  onTap: () async {
                    await AppRoutes.pushNamed(RouteNames.ownerRevenue);

                  kpisFuture = ApiService().getDashboardKPIs();
                  setState(() {

                  });},
                ),
                const SizedBox(height: 12),
                _QuickActionButton(
                  icon: Icons.supervisor_account,
                  title: 'Manage Staff',
                  subtitle: 'Add or remove staff',
                  onTap: () async {
                    await AppRoutes.pushNamed(RouteNames.ownerTrainers);

                    kpisFuture = ApiService().getDashboardKPIs();
                    setState(() {

                    });

                  }
                ),
              ],
            ),
          ),   // SingleChildScrollView
          );   // RefreshIndicator
        },
      ),
      // bottomNavigationBar: BottomNavigationBar(
      //   type: BottomNavigationBarType.fixed,
      //   currentIndex: selectedIndex,
      //   onTap: (index) async{
      //     setState(() => selectedIndex = index);
      //     switch (index) {
      //       case 0:
      //         break;
      //       case 1:
      //         await context.push('/owner/members');
      //         kpisFuture = ApiService().getDashboardKPIs();
      //         setState(() {
      //
      //         });
      //         break;
      //       case 2:
      //         await context.push('/owner/tasks');
      //         kpisFuture = ApiService().getDashboardKPIs();
      //         setState(() {
      //
      //         });
      //         break;
      //       case 3:
      //         await context.push('/owner/revenue');
      //         kpisFuture = ApiService().getDashboardKPIs();
      //         setState(() {
      //
      //         });
      //         break;
      //     }
      //   },
      //   items: const [
      //     BottomNavigationBarItem(icon: Icon(Icons.home,color: Colors.blue), label: 'Dashboard'),
      //     BottomNavigationBarItem(icon: Icon(Icons.people,color: Colors.blue,), label: 'Members'),
      //     BottomNavigationBarItem(icon: Icon(Icons.assignment,color: Colors.blue), label: 'Tasks'),
      //     BottomNavigationBarItem(icon: Icon(Icons.trending_up,color: Colors.blue), label: 'Revenue'),
      //   ],
      // ),
    );
  }
}

class _SubscriptionBanner extends StatelessWidget {
  final BusinessSubscriptionResponse sub;
  final String businessId;
  const _SubscriptionBanner({required this.sub, required this.businessId});

  @override
  Widget build(BuildContext context) {
    final isActive = sub.status == 'active';
    final isExpired = sub.status == 'expired';
    final daysLeft = sub.daysRemaining;

    if (isActive && daysLeft > 7) return const SizedBox.shrink();

    Color color;
    IconData icon;
    String message;

    if (isExpired) {
      color = Colors.red;
      icon = Icons.cancel_outlined;
      message = 'Your subscription has expired. Renew now to keep access.';
    } else if (isActive) {
      color = Colors.orange;
      icon = Icons.warning_amber_outlined;
      message = 'Subscription expires in $daysLeft day${daysLeft == 1 ? '' : 's'}. Renew now.';
    } else if (daysLeft <= 0) {
      color = Colors.red;
      icon = Icons.hourglass_disabled;
      message = 'Your free trial has expired. Subscribe to continue.';
    } else {
      color = daysLeft <= 3 ? Colors.red : Colors.orange;
      icon = Icons.hourglass_top;
      message = '$daysLeft day${daysLeft == 1 ? '' : 's'} left in your free trial.';
    }

    return GestureDetector(
      onTap: () => context.push('/subscription'),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.5)),
        ),
        child: Row(
          children: [
            Icon(icon, color: color, size: 20),
            const SizedBox(width: 10),
            Expanded(child: Text(message, style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: 13))),
            Icon(Icons.arrow_forward_ios, color: color, size: 14),
          ],
        ),
      ),
    );
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
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.2),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: color, size: 28),
            ),
            const SizedBox(height: 12),
            Text(
              value,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.bold,
                color: color,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              title,
              style: Theme.of(context).textTheme.bodySmall,
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _QuickActionButton extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _QuickActionButton({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: ListTile(
        leading: Icon(icon, color: const Color(0xFF2196F3), size: 28),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Text(subtitle),
        trailing: const Icon(Icons.arrow_forward_ios, size: 16),
        onTap: onTap,
      ),
    );
  }
}
