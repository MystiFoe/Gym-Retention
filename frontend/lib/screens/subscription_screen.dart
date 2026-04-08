// ignore: avoid_web_libraries_in_flutter
import 'dart:js' as js;
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/api_service.dart';
import '../models/models.dart';
import '../utils/error_helper.dart';

class SubscriptionScreen extends StatefulWidget {
  const SubscriptionScreen({super.key});

  @override
  State<SubscriptionScreen> createState() => _SubscriptionScreenState();
}

class _SubscriptionScreenState extends State<SubscriptionScreen> {
  late Future<GymSubscriptionResponse> _subFuture;
  String _selectedPlan = 'monthly';
  bool _isProcessing = false;
  String? _gymId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    _gymId = prefs.getString('gym_id');
    if (_gymId != null) {
      setState(() {
        _subFuture = ApiService().getGymSubscription(_gymId!);
      });
    }
  }

  Future<void> _startPayment(BillingPlan plan) async {
    if (_gymId == null) return;
    setState(() => _isProcessing = true);

    try {
      final order = await ApiService().createBillingOrder(gymId: _gymId!, plan: plan.id);
      final gymId = _gymId!;
      final planId = plan.id;
      final messenger = ScaffoldMessenger.of(context);

      // dart:js automatically wraps Dart functions passed to callMethod
      js.context.callMethod('openRazorpayCheckout', [
        js.JsObject.jsify({
          'key_id': order.keyId,
          'amount': order.amount,
          'currency': order.currency,
          'order_id': order.orderId,
          'gym_name': order.gymName,
          'plan_label': order.planLabel,
        }),
        (String paymentId, String orderId, String signature) async {
          try {
            await ApiService().verifyPayment(
              gymId: gymId,
              razorpayOrderId: orderId,
              razorpayPaymentId: paymentId,
              razorpaySignature: signature,
              plan: planId,
            );
            if (mounted) {
              messenger.showSnackBar(const SnackBar(
                content: Text('Subscription activated successfully!'),
                backgroundColor: Colors.green,
              ));
              setState(() {
                _isProcessing = false;
                _subFuture = ApiService().getGymSubscription(gymId);
              });
            }
          } catch (e) {
            if (mounted) {
              setState(() => _isProcessing = false);
              messenger.showSnackBar(SnackBar(
                content: Text(friendlyError(e)), backgroundColor: Colors.red,
              ));
            }
          }
        },
        (String error) {
          if (mounted) {
            setState(() => _isProcessing = false);
            messenger.showSnackBar(SnackBar(
              content: Text('Payment failed: $error'), backgroundColor: Colors.red,
            ));
          }
        },
      ]);
    } catch (e) {
      if (mounted) {
        setState(() => _isProcessing = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyError(e)), backgroundColor: Colors.red),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Subscription'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/owner/dashboard'),
        ),
      ),
      body: _gymId == null
          ? const Center(child: CircularProgressIndicator())
          : FutureBuilder<GymSubscriptionResponse>(
              future: _subFuture,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Center(child: Text(friendlyError(snapshot.error!)));
                }
                final sub = snapshot.data!;
                return SingleChildScrollView(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _StatusCard(sub: sub),
                      const SizedBox(height: 24),
                      if (sub.status != 'active') ...[
                        Text(
                          'Choose a Plan',
                          style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
                        ),
                        const SizedBox(height: 16),
                        ...sub.plans.map((plan) => _PlanCard(
                          plan: plan,
                          isSelected: _selectedPlan == plan.id,
                          onTap: () => setState(() => _selectedPlan = plan.id),
                        )),
                        const SizedBox(height: 24),
                        SizedBox(
                          height: 56,
                          child: ElevatedButton(
                            onPressed: _isProcessing ? null : () {
                              final plan = sub.plans.firstWhere((p) => p.id == _selectedPlan);
                              _startPayment(plan);
                            },
                            child: _isProcessing
                                ? const SizedBox(
                                    height: 24, width: 24,
                                    child: CircularProgressIndicator(strokeWidth: 2, valueColor: AlwaysStoppedAnimation(Colors.white)),
                                  )
                                : Text(
                                    'Pay & Subscribe — ${sub.plans.firstWhere((p) => p.id == _selectedPlan, orElse: () => sub.plans.first).amountDisplay}',
                                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                                  ),
                          ),
                        ),
                        const SizedBox(height: 12),
                        const Text(
                          'Secured by Razorpay. Supports UPI, Cards, Net Banking & Wallets.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 12, color: Colors.grey),
                        ),
                      ],
                    ],
                  ),
                );
              },
            ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  final GymSubscriptionResponse sub;
  const _StatusCard({required this.sub});

  @override
  Widget build(BuildContext context) {
    final isActive = sub.status == 'active';
    final isTrial = sub.status == 'trial';
    final color = isActive ? Colors.green : (sub.daysRemaining <= 3 ? Colors.red : Colors.orange);
    final icon = isActive ? Icons.check_circle : (sub.daysRemaining <= 3 ? Icons.warning : Icons.hourglass_top);

    String subtitle;
    if (isActive) {
      subtitle = 'Active until ${sub.subscriptionEndsAt?.toLocal().toString().split(' ')[0] ?? '—'}';
    } else if (isTrial) {
      subtitle = sub.daysRemaining > 0
          ? '${sub.daysRemaining} day${sub.daysRemaining == 1 ? '' : 's'} remaining in trial'
          : 'Trial has expired';
    } else {
      subtitle = 'Subscription expired';
    }

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 40),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isActive ? 'Subscription Active' : (isTrial ? 'Free Trial' : 'Subscription Expired'),
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: color),
                ),
                const SizedBox(height: 4),
                Text(subtitle, style: TextStyle(color: color.withValues(alpha: 0.8))),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  final BillingPlan plan;
  final bool isSelected;
  final VoidCallback onTap;
  const _PlanCard({required this.plan, required this.isSelected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final savings = plan.months == 3 ? 'Save 17%' : plan.months == 12 ? 'Save 33%' : null;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isSelected ? const Color(0xFF2196F3) : Colors.grey.shade300,
            width: isSelected ? 2 : 1,
          ),
          color: isSelected ? const Color(0xFF2196F3).withValues(alpha: 0.05) : Colors.white,
        ),
        child: Row(
          children: [
            Radio<bool>(
              value: true,
              groupValue: isSelected,
              onChanged: (_) => onTap(),
              activeColor: const Color(0xFF2196F3),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(plan.label, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                      if (savings != null) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: Colors.green,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(savings, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold)),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    plan.months == 1
                        ? 'per month'
                        : '${plan.months} months (${plan.amountDisplay} total)',
                    style: const TextStyle(color: Colors.grey, fontSize: 13),
                  ),
                ],
              ),
            ),
            Text(
              plan.amountDisplay,
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 18,
                color: isSelected ? const Color(0xFF2196F3) : Colors.black87,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
