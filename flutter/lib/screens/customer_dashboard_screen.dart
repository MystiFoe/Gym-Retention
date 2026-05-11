import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';
import '../services/api_service.dart';
import '../models/models.dart';
import '../utils/appui_helper.dart';

class MemberDashboardScreen extends StatefulWidget {
  const MemberDashboardScreen({super.key});

  @override
  State<MemberDashboardScreen> createState() => _MemberDashboardScreenState();
}

class _MemberDashboardScreenState extends State<MemberDashboardScreen> {
  int _tab = 0;
  DateTime? _lastBack;

  Future<void> _onBack() async {
    final now = DateTime.now();
    if (_lastBack != null && now.difference(_lastBack!) < const Duration(seconds: 2)) {
      SystemNavigator.pop();
      return;
    }
    _lastBack = now;
    final exit = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Exit App'),
        content: const Text('Do you want to quit Recurva?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('No')),
          TextButton(onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Yes', style: TextStyle(color: Colors.red))),
        ],
      ),
    );
    if (exit == true) SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async { if (!didPop) await _onBack(); },
      child: Scaffold(
        body: IndexedStack(
          index: _tab,
          children: const [
            _AttendanceTab(),
            _PaymentsTab(),
            _ProfileTab(),
          ],
        ),
        bottomNavigationBar: BottomNavigationBar(
          currentIndex: _tab,
          onTap: (i) => setState(() => _tab = i),
          type: BottomNavigationBarType.fixed,
          selectedItemColor: const Color(0xFF2196F3),
          unselectedItemColor: Colors.grey,
          items: const [
            BottomNavigationBarItem(icon: Icon(Icons.calendar_month_outlined), activeIcon: Icon(Icons.calendar_month), label: 'Attendance'),
            BottomNavigationBarItem(icon: Icon(Icons.payment_outlined),        activeIcon: Icon(Icons.payment),        label: 'Payments'),
            BottomNavigationBarItem(icon: Icon(Icons.person_outline),          activeIcon: Icon(Icons.person),         label: 'Profile'),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────── ATTENDANCE TAB ──────────────────────────────────

class _AttendanceTab extends StatefulWidget {
  const _AttendanceTab();
  @override
  State<_AttendanceTab> createState() => _AttendanceTabState();
}

class _AttendanceTabState extends State<_AttendanceTab> {
  DateTime _month = DateTime(DateTime.now().year, DateTime.now().month);
  List<Map<String, dynamic>> _records = [];
  bool _loading = false;
  bool _marking = false;
  bool? _markedToday; // null=unknown, true=marked, false=not marked
  String? _todaySource;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    _checkTodayStatus();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final data = await ApiService().getMyAttendance(year: _month.year, month: _month.month);
      if (mounted) setState(() { _records = data; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _loading = false; _error = e.toString().replaceFirst('Exception: ', ''); });
    }
  }

  Future<void> _checkTodayStatus() async {
    // Check if today is in current month's records
    final now = DateTime.now();
    if (_month.year != now.year || _month.month != now.month) return;
    final today = '${now.year}-${now.month.toString().padLeft(2,'0')}-${now.day.toString().padLeft(2,'0')}';
    final rec = _records.where((r) => r['date'].toString().startsWith(today)).firstOrNull;
    if (mounted) {
      setState(() {
        _markedToday = rec != null;
        _todaySource = rec?['source'] as String?;
      });
    }
  }

  Future<void> _markAttendance() async {
    setState(() => _marking = true);
    try {
      final result = await ApiService().selfCheckIn();
      final alreadyMarked = result['already_marked'] == true;
      if (mounted) {
        setState(() { _marking = false; _markedToday = true; _todaySource = result['source'] as String? ?? 'mobile'; });
        AppUiHelper().showModernSnackBar(
          context,
          message: alreadyMarked ? 'Already marked today ✓' : 'Attendance marked for today ✓',
        );
        _load(); // refresh calendar
      }
    } catch (e) {
      if (mounted) {
        setState(() => _marking = false);
        AppUiHelper().showModernSnackBar(context, message: e.toString().replaceFirst('Exception: ', ''), isError: true);
      }
    }
  }

  void _changeMonth(int delta) {
    setState(() => _month = DateTime(_month.year, _month.month + delta));
    _load().then((_) => _checkTodayStatus());
  }

  @override
  Widget build(BuildContext context) {
    final isCurrentMonth = _month.year == DateTime.now().year && _month.month == DateTime.now().month;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Attendance'),
        backgroundColor: const Color(0xFF2196F3),
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await ApiService().logout();
              if (context.mounted) context.go('/login');
            },
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: kIsWeb ? 700 : double.infinity),
          child: Column(
            children: [
              // ── Mark attendance button ───────────────────────────────
              if (isCurrentMonth)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
                  child: _MarkAttendanceCard(
                    marked: _markedToday,
                    source: _todaySource,
                    loading: _marking,
                    onMark: _markAttendance,
                  ),
                ),

              // ── Month navigator ──────────────────────────────────────
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    IconButton(onPressed: () => _changeMonth(-1), icon: const Icon(Icons.chevron_left)),
                    Text(_monthLabel, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                    IconButton(
                      onPressed: isCurrentMonth ? null : () => _changeMonth(1),
                      icon: const Icon(Icons.chevron_right),
                    ),
                  ],
                ),
              ),

              // ── Legend ───────────────────────────────────────────────
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Row(children: [
                  _legend(const Color(0xFF1976D2), '📱 Mobile'),
                  const SizedBox(width: 16),
                  _legend(Colors.green, '👆 Biometric/Staff'),
                  const SizedBox(width: 16),
                  _legend(Colors.grey.shade300, 'No data'),
                ]),
              ),
              const SizedBox(height: 8),

              // ── Calendar ─────────────────────────────────────────────
              if (_loading)
                const Expanded(child: Center(child: CircularProgressIndicator()))
              else if (_error != null)
                Expanded(child: Center(child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.error_outline, size: 48, color: Colors.orange),
                    const SizedBox(height: 12),
                    Text(_error!, textAlign: TextAlign.center),
                    const SizedBox(height: 12),
                    TextButton(onPressed: _load, child: const Text('Retry')),
                  ]),
                )))
              else
                Expanded(child: _CalendarGrid(month: _month, records: _records)),

              // ── Summary ──────────────────────────────────────────────
              Padding(
                padding: const EdgeInsets.all(16),
                child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
                  _SummaryChip(label: 'Present',  count: _records.where((r) => r['status'] == 'present').length, color: Colors.green),
                  _SummaryChip(label: 'Mobile',   count: _records.where((r) => r['source'] == 'mobile').length,    color: const Color(0xFF1976D2)),
                  _SummaryChip(label: 'Biometric',count: _records.where((r) => r['source'] == 'biometric').length, color: Colors.teal),
                ]),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String get _monthLabel {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return '${months[_month.month - 1]} ${_month.year}';
  }

  Widget _legend(Color color, String label) => Row(children: [
    Container(width: 12, height: 12, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
    const SizedBox(width: 4),
    Text(label, style: const TextStyle(fontSize: 11)),
  ]);
}

class _MarkAttendanceCard extends StatelessWidget {
  final bool? marked;
  final String? source;
  final bool loading;
  final VoidCallback onMark;
  const _MarkAttendanceCard({required this.marked, this.source, required this.loading, required this.onMark});

  @override
  Widget build(BuildContext context) {
    final alreadyMarked = marked == true;
    final color = alreadyMarked ? Colors.green : const Color(0xFF2196F3);
    final isMobile = source == 'mobile';
    final isBiometric = source == 'biometric';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Icon(
            alreadyMarked ? Icons.check_circle : Icons.fingerprint,
            color: color, size: 36,
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  alreadyMarked ? 'Today — Present ✓' : "Mark Today's Attendance",
                  style: TextStyle(fontWeight: FontWeight.bold, color: color, fontSize: 15),
                ),
                if (alreadyMarked)
                  Text(
                    isMobile ? '📱 Marked via mobile app' : isBiometric ? '👆 Verified by biometric' : '👤 Marked by staff',
                    style: TextStyle(fontSize: 12, color: color.withValues(alpha: 0.8)),
                  )
                else
                  const Text('Tap to mark your attendance for today', style: TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ),
          ),
          if (!alreadyMarked)
            ElevatedButton(
              onPressed: loading ? null : onMark,
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF2196F3),
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              ),
              child: loading
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Mark', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
        ],
      ),
    );
  }
}

class _CalendarGrid extends StatelessWidget {
  final DateTime month;
  final List<Map<String, dynamic>> records;
  const _CalendarGrid({required this.month, required this.records});

  @override
  Widget build(BuildContext context) {
    final firstDay   = DateTime(month.year, month.month, 1);
    final daysInMonth = DateTime(month.year, month.month + 1, 0).day;
    final startWeekday = firstDay.weekday % 7;
    const headers = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    // Build lookup: dateStr -> source
    final Map<String, String> dateSource = {};
    for (final r in records) {
      final ds = r['date'].toString().substring(0, 10);
      if (r['status'] == 'present') dateSource[ds] = r['source'] as String? ?? 'staff';
    }

    return GridView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 7, childAspectRatio: 1),
      itemCount: 7 + startWeekday + daysInMonth,
      itemBuilder: (_, i) {
        if (i < 7) return Center(child: Text(headers[i], style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.grey)));
        final ci = i - 7;
        if (ci < startWeekday) return const SizedBox();
        final day = ci - startWeekday + 1;
        final dateStr = '${month.year}-${month.month.toString().padLeft(2,'0')}-${day.toString().padLeft(2,'0')}';
        final source = dateSource[dateStr];
        final isPresent = source != null;
        // Mobile → blue, biometric/staff → green, absent → light grey
        final color = isPresent
            ? (source == 'mobile' ? const Color(0xFF1976D2) : Colors.green)
            : Colors.grey.shade200;
        final textColor = isPresent ? Colors.white : Colors.black87;
        return Container(
          margin: const EdgeInsets.all(3),
          decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(8)),
          alignment: Alignment.center,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text('$day', style: TextStyle(color: textColor, fontWeight: FontWeight.bold, fontSize: 13)),
              if (source == 'mobile')
                const Text('📱', style: TextStyle(fontSize: 8)),
              if (source == 'biometric')
                const Text('👆', style: TextStyle(fontSize: 8)),
            ],
          ),
        );
      },
    );
  }
}

class _SummaryChip extends StatelessWidget {
  final String label;
  final int count;
  final Color color;
  const _SummaryChip({required this.label, required this.count, required this.color});

  @override
  Widget build(BuildContext context) => Column(children: [
    Text('$count', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: color)),
    Text(label, style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
  ]);
}

// ─────────────────────────── PAYMENTS TAB ────────────────────────────────────

class _PaymentsTab extends StatefulWidget {
  const _PaymentsTab();
  @override
  State<_PaymentsTab> createState() => _PaymentsTabState();
}

class _PaymentsTabState extends State<_PaymentsTab> {
  CustomerProfile? _profile;
  List<Payment> _payments = [];
  bool _loading = true;
  String? _error;
  Razorpay? _razorpay;

  @override
  void initState() {
    super.initState();
    if (!kIsWeb) _initRazorpay();
    _load();
  }

  void _initRazorpay() {
    _razorpay = Razorpay();
    _razorpay!.on(Razorpay.EVENT_PAYMENT_SUCCESS, _onPaymentSuccess);
    _razorpay!.on(Razorpay.EVENT_PAYMENT_ERROR,   _onPaymentError);
    _razorpay!.on(Razorpay.EVENT_EXTERNAL_WALLET, (_) {});
  }

  @override
  void dispose() {
    _razorpay?.clear();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final results = await Future.wait([
        ApiService().getCustomerProfile(),
        ApiService().getCustomerPayments(),
      ]);
      if (mounted) {
        setState(() {
          _profile  = results[0] as CustomerProfile;
          _payments = (results[1] as PaymentsResponse).payments;
          _loading  = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() { _error = e.toString().replaceFirst('Exception: ', ''); _loading = false; });
      }
    }
  }

  Future<void> _pay() async {
    if (_profile == null || kIsWeb) {
      AppUiHelper().showModernSnackBar(context, message: 'Payments only available on mobile app.', isError: true);
      return;
    }
    final amount = _profile!.planFee;
    final gymName = _profile!.gymName;
    final phone   = _profile!.phone;
    final email   = _profile!.email;
    try {
      final order = await ApiService().createPaymentOrder(amount: amount, description: 'Gym subscription renewal');
      _razorpay!.open({
        'key': order.keyId, 'amount': order.amount, 'currency': order.currency,
        'order_id': order.orderId, 'name': gymName, 'description': 'Subscription Renewal',
        'prefill': {'contact': phone, 'email': email},
      });
    } catch (e) {
      if (mounted) AppUiHelper().showModernSnackBar(context, message: e.toString().replaceFirst('Exception: ', ''), isError: true);
    }
  }

  void _onPaymentSuccess(PaymentSuccessResponse resp) async {
    try {
      await ApiService().verifyMemberPayment(
        razorpayOrderId:   resp.orderId   ?? '',
        razorpayPaymentId: resp.paymentId ?? '',
        razorpaySignature: resp.signature ?? '',
      );
      if (mounted) AppUiHelper().showModernSnackBar(context, message: 'Payment successful! Thank you.');
      _load();
    } catch (e) {
      if (mounted) AppUiHelper().showModernSnackBar(context, message: 'Payment done but verification failed. Contact your gym.', isError: true);
    }
  }

  void _onPaymentError(PaymentFailureResponse resp) {
    AppUiHelper().showModernSnackBar(context, message: 'Payment failed. Please try again.', isError: true);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Payments'), backgroundColor: const Color(0xFF2196F3), foregroundColor: Colors.white),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.error_outline, size: 48, color: Colors.red),
                  const SizedBox(height: 8),
                  Text(_error!),
                  TextButton(onPressed: _load, child: const Text('Retry')),
                ]))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: CustomScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    slivers: [
                      // Plan details card
                      if (_profile != null)
                        SliverToBoxAdapter(
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: _PlanCard(profile: _profile!, onPay: _profile!.paymentEnabled ? _pay : null),
                          ),
                        ),

                      // Payment history header
                      SliverPadding(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                        sliver: SliverToBoxAdapter(
                          child: Text('Payment History',
                              style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                        ),
                      ),

                      if (_payments.isEmpty)
                        const SliverFillRemaining(
                          hasScrollBody: false,
                          child: Center(child: Text('No payments yet', style: TextStyle(color: Colors.grey))),
                        )
                      else
                        SliverPadding(
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                          sliver: SliverList(delegate: SliverChildBuilderDelegate(
                            (_, i) => _PaymentTile(payment: _payments[i]),
                            childCount: _payments.length,
                          )),
                        ),
                    ],
                  ),
                ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  final CustomerProfile profile;
  final VoidCallback? onPay;
  const _PlanCard({required this.profile, this.onPay});

  @override
  Widget build(BuildContext context) {
    final expiring = profile.daysUntilExpiry <= 7;
    final expired  = profile.daysUntilExpiry < 0;
    final color = expired ? Colors.red : expiring ? Colors.orange : const Color(0xFF2196F3);

    return Card(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      elevation: 2,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(profile.gymName, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: color.withValues(alpha: 0.4)),
                  ),
                  child: Text(
                    expired ? 'Expired' : expiring ? 'Expiring Soon' : 'Active',
                    style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 12),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            _planRow(Icons.card_membership, 'Plan', profile.planDisplay),
            const SizedBox(height: 8),
            _planRow(Icons.currency_rupee, 'Plan Fee', '₹${profile.planFee.toStringAsFixed(0)}'),
            const SizedBox(height: 8),
            _planRow(Icons.calendar_today, 'Subscription Ends', _fmt(profile.membershipExpiryDate)),
            const SizedBox(height: 8),
            _planRow(Icons.timelapse, 'Days Remaining',
                expired ? 'Expired' : '${profile.daysUntilExpiry} days'),
            if (onPay != null) ...[
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: onPay,
                  icon: const Icon(Icons.payment),
                  label: Text('Renew for ₹${profile.planFee.toStringAsFixed(0)}',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF2196F3),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
            ],
            if (onPay == null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  'Online payment not configured for this gym. Contact your gym to renew.',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _planRow(IconData icon, String label, String value) => Row(children: [
    Icon(icon, size: 16, color: Colors.grey.shade500),
    const SizedBox(width: 8),
    Text('$label: ', style: TextStyle(fontSize: 13, color: Colors.grey.shade600)),
    Text(value, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
  ]);

  String _fmt(DateTime d) => '${d.day.toString().padLeft(2,'0')}-${d.month.toString().padLeft(2,'0')}-${d.year}';
}

class _PaymentTile extends StatelessWidget {
  final Payment payment;
  const _PaymentTile({required this.payment});

  @override
  Widget build(BuildContext context) {
    final success = payment.status == 'completed';
    final color   = success ? Colors.green : Colors.orange;
    final date    = '${payment.createdAt.day.toString().padLeft(2,'0')}-'
                    '${payment.createdAt.month.toString().padLeft(2,'0')}-'
                    '${payment.createdAt.year}';
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: ListTile(
        leading: Container(
          width: 44, height: 44,
          decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
          child: Icon(success ? Icons.check_circle_outline : Icons.pending_outlined, color: color),
        ),
        title: Text('₹${payment.amountRupees.toStringAsFixed(0)}',
            style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Text('${payment.description ?? 'Payment'} · $date'),
        trailing: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: color.withValues(alpha: 0.4)),
          ),
          child: Text(success ? 'Paid' : payment.status,
              style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.bold)),
        ),
      ),
    );
  }
}

// ─────────────────────────── PROFILE TAB ─────────────────────────────────────

class _ProfileTab extends StatefulWidget {
  const _ProfileTab();
  @override
  State<_ProfileTab> createState() => _ProfileTabState();
}

class _ProfileTabState extends State<_ProfileTab> {
  CustomerProfile? _profile;
  bool _loading = true;
  bool _editing = false;
  bool _saving  = false;
  bool _linking = false;
  String? _error;
  final _nameCtrl  = TextEditingController();
  final _emailCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _emailCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final p = await ApiService().getCustomerProfile();
      if (mounted) setState(() { _profile = p; _nameCtrl.text = p.name; _emailCtrl.text = p.email; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _loading = false; _error = e.toString().replaceFirst('Exception: ', ''); });
    }
  }

  Future<void> _showLinkAccountDialog() async {
    final phoneCtrl = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('Link Your Account'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Enter the phone number your gym owner used when adding you as a member.',
              style: TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: phoneCtrl,
              keyboardType: TextInputType.phone,
              autofocus: true,
              decoration: InputDecoration(
                labelText: 'Registered Phone Number',
                prefixIcon: const Icon(Icons.phone),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF2196F3), foregroundColor: Colors.white),
            child: const Text('Link'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;
    final phone = phoneCtrl.text.trim();
    if (phone.isEmpty) return;

    setState(() { _linking = true; _error = null; });
    try {
      await ApiService().linkMemberAccount(phone: phone);
      if (mounted) {
        AppUiHelper().showModernSnackBar(context, message: 'Account linked! Loading your profile...');
        _load();
      }
    } catch (e) {
      if (mounted) {
        setState(() { _linking = false; _error = e.toString().replaceFirst('Exception: ', ''); });
        AppUiHelper().showModernSnackBar(context, message: _error!, isError: true);
      }
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await ApiService().updateCustomerProfile(name: _nameCtrl.text.trim(), email: _emailCtrl.text.trim());
      if (mounted) {
        AppUiHelper().showModernSnackBar(context, message: 'Profile updated successfully');
        setState(() { _editing = false; _saving = false; });
      }
      _load();
    } catch (e) {
      if (mounted) {
        setState(() => _saving = false);
        AppUiHelper().showModernSnackBar(context, message: e.toString().replaceFirst('Exception: ', ''), isError: true);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('My Profile'),
        backgroundColor: const Color(0xFF2196F3),
        foregroundColor: Colors.white,
        actions: [
          if (!_editing && _profile != null)
            IconButton(icon: const Icon(Icons.edit), onPressed: () => setState(() => _editing = true)),
          if (_editing)
            IconButton(icon: const Icon(Icons.close), onPressed: () {
              setState(() { _editing = false; });
              if (_profile != null) { _nameCtrl.text = _profile!.name; _emailCtrl.text = _profile!.email; }
            }),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null && _profile == null
              ? Center(child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.error_outline, size: 56, color: Colors.red),
                      const SizedBox(height: 16),
                      Text(_error!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 14)),
                      const SizedBox(height: 20),
                      ElevatedButton(onPressed: _load, child: const Text('Retry')),
                      const SizedBox(height: 8),
                      ElevatedButton.icon(
                        icon: _linking
                            ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                            : const Icon(Icons.link),
                        label: const Text('Link Account'),
                        onPressed: _linking ? null : _showLinkAccountDialog,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.orange,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Use this if your gym added you manually',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                      ),
                      const SizedBox(height: 8),
                      TextButton.icon(
                        icon: const Icon(Icons.logout, color: Colors.red),
                        label: const Text('Logout', style: TextStyle(color: Colors.red)),
                        onPressed: () async { await ApiService().logout(); if (context.mounted) context.go('/login'); },
                      ),
                    ],
                  ),
                ))
              : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  const SizedBox(height: 8),

                  // QR code card
                  if (_profile != null) ...[
                    Card(
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                      elevation: 2,
                      child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: Column(
                          children: [
                            const Text('My Attendance QR',
                                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                            const SizedBox(height: 4),
                            Text('Show this to staff to mark attendance',
                                style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                            const SizedBox(height: 16),
                            QrImageView(
                              data: 'recurva://member/${_profile!.id}',
                              version: QrVersions.auto,
                              size: 160,
                              eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: Color(0xFF2196F3)),
                              dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: Colors.black87),
                            ),
                            const SizedBox(height: 8),
                            Text(_profile!.name, style: const TextStyle(fontWeight: FontWeight.bold)),
                            Text(_profile!.gymName, style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                  ],

                  // Edit fields
                  TextField(
                    controller: _nameCtrl, enabled: _editing,
                    decoration: InputDecoration(labelText: 'Full Name', prefixIcon: const Icon(Icons.person_outline),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12))),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: TextEditingController(text: _profile?.phone ?? ''), enabled: false,
                    decoration: InputDecoration(
                      labelText: 'Phone (login — cannot change)',
                      prefixIcon: const Icon(Icons.phone_outlined),
                      suffixIcon: _profile?.phoneVerified == true
                          ? const Tooltip(message: 'Phone verified', child: Icon(Icons.verified, color: Colors.green, size: 20))
                          : const Tooltip(message: 'Phone not verified', child: Icon(Icons.warning_amber_rounded, color: Colors.orange, size: 20)),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _emailCtrl, enabled: _editing, keyboardType: TextInputType.emailAddress,
                    decoration: InputDecoration(
                      labelText: 'Email Address',
                      prefixIcon: const Icon(Icons.email_outlined),
                      suffixIcon: _profile?.emailVerified == true
                          ? const Tooltip(message: 'Email verified', child: Icon(Icons.verified, color: Colors.green, size: 20))
                          : const Tooltip(message: 'Email not verified', child: Icon(Icons.warning_amber_rounded, color: Colors.orange, size: 20)),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                  const SizedBox(height: 24),
                  if (_editing)
                    SizedBox(
                      width: double.infinity, height: 52,
                      child: ElevatedButton(
                        onPressed: _saving ? null : _save,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF2196F3), foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        ),
                        child: _saving
                            ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                            : const Text('Save Changes', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                      ),
                    ),
                  const SizedBox(height: 16),

                  // Show Link Account when profile loaded but phone is missing (broken link)
                  if (!_editing && (_profile?.phone == null || _profile!.phone.isEmpty)) ...[
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: Colors.orange.shade50,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: Colors.orange.shade200),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(children: [
                            Icon(Icons.warning_amber_rounded, color: Colors.orange.shade700, size: 18),
                            const SizedBox(width: 6),
                            Text('Profile not fully linked', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.orange.shade800, fontSize: 13)),
                          ]),
                          const SizedBox(height: 4),
                          Text(
                            'Your account is not linked to your gym membership. Enter your gym-registered phone number to fix this.',
                            style: TextStyle(fontSize: 12, color: Colors.orange.shade700),
                          ),
                          const SizedBox(height: 10),
                          SizedBox(
                            width: double.infinity,
                            child: ElevatedButton.icon(
                              icon: _linking
                                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                                  : const Icon(Icons.link, size: 18),
                              label: const Text('Link My Account'),
                              onPressed: _linking ? null : _showLinkAccountDialog,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: Colors.orange.shade700,
                                foregroundColor: Colors.white,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],

                  SizedBox(
                    width: double.infinity, height: 48,
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.logout, color: Colors.red),
                      label: const Text('Logout', style: TextStyle(color: Colors.red)),
                      onPressed: () async { await ApiService().logout(); if (context.mounted) context.go('/login'); },
                      style: OutlinedButton.styleFrom(
                        side: const BorderSide(color: Colors.red),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}
