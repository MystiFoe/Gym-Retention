import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_service.dart';

// ============================================================================
// MEMBER ATTENDANCE CALENDAR SCREEN
// Shown when owner or trainer taps a member in the members list.
// Layout:
//   ┌─────────────────────────────┐
//   │  Customer Details (2 columns) │
//   ├─────────────────────────────┤
//   │  Month Navigation           │
//   ├─────────────────────────────┤
//   │  Calendar Grid              │
//   │  ● Green  = Present         │
//   │  ● Red    = Absent          │
//   │  ○ Empty  = No data         │
//   └─────────────────────────────┘
// ============================================================================

class MemberAttendanceScreen extends StatefulWidget {
  final Customer member;

  const MemberAttendanceScreen({super.key, required this.member});

  @override
  State<MemberAttendanceScreen> createState() => _MemberAttendanceScreenState();
}

class _MemberAttendanceScreenState extends State<MemberAttendanceScreen> {
  late DateTime _displayedMonth;
  Set<String> _presentDates = {};
  bool _loading = false;
  String? _error;

  // Earliest month we can navigate to = member's join month
  late DateTime _firstMonth;
  // Latest month = current month
  final DateTime _lastMonth = DateTime(DateTime.now().year, DateTime.now().month);

  @override
  void initState() {
    super.initState();
    _displayedMonth = _lastMonth;
    _firstMonth = DateTime(
      widget.member.createdAt.year,
      widget.member.createdAt.month,
    );
    _fetchAttendance();
  }

  String get _monthKey =>
      '${_displayedMonth.year}-${_displayedMonth.month.toString().padLeft(2, '0')}';

  Future<void> _fetchAttendance() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await ApiService().getCustomerAttendance(
        customerId: widget.member.id,
        month: _monthKey,
      );
      if (mounted) {
        setState(() {
          _presentDates = result.presentDates.toSet();
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  void _previousMonth() {
    final prev = DateTime(_displayedMonth.year, _displayedMonth.month - 1);
    if (!prev.isBefore(_firstMonth)) {
      setState(() => _displayedMonth = prev);
      _fetchAttendance();
    }
  }

  void _nextMonth() {
    final next = DateTime(_displayedMonth.year, _displayedMonth.month + 1);
    if (!next.isAfter(_lastMonth)) {
      setState(() => _displayedMonth = next);
      _fetchAttendance();
    }
  }

  bool get _canGoPrev {
    final prev = DateTime(_displayedMonth.year, _displayedMonth.month - 1);
    return !prev.isBefore(_firstMonth);
  }

  bool get _canGoNext {
    final next = DateTime(_displayedMonth.year, _displayedMonth.month + 1);
    return !next.isAfter(_lastMonth);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final statusColor = _statusColor(widget.member.status);

    return Scaffold(
      backgroundColor: const Color(0xFFF5F6FA),
      appBar: AppBar(
        elevation: 0,
        backgroundColor: theme.primaryColor,
        foregroundColor: Colors.white,
        title: Text(
          widget.member.name,
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
        centerTitle: true,
      ),
      body: GestureDetector(
        onHorizontalDragEnd: (details) {
          if (details.primaryVelocity != null) {
            if (details.primaryVelocity! < -300) _nextMonth();
            if (details.primaryVelocity! > 300) _previousMonth();
          }
        },
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // ── Customer details card ────────────────────────────────────────
              _MemberDetailsCard(member: widget.member, statusColor: statusColor),

              const SizedBox(height: 16),

              // ── Attendance Calendar card ───────────────────────────────────
              Card(
                elevation: 2,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16)),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Month navigation header
                      _MonthNavigationHeader(
                        displayedMonth: _displayedMonth,
                        canGoPrev: _canGoPrev,
                        canGoNext: _canGoNext,
                        onPrevious: _previousMonth,
                        onNext: _nextMonth,
                      ),

                      const SizedBox(height: 12),

                      // Legend
                      _CalendarLegend(),

                      const SizedBox(height: 12),

                      // Calendar grid
                      if (_loading)
                        const SizedBox(
                          height: 220,
                          child: Center(child: CircularProgressIndicator()),
                        )
                      else if (_error != null)
                        SizedBox(
                          height: 220,
                          child: Center(
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                const Icon(Icons.error_outline,
                                    color: Colors.red, size: 36),
                                const SizedBox(height: 8),
                                Text(_error!,
                                    textAlign: TextAlign.center,
                                    style:
                                        const TextStyle(color: Colors.red)),
                                const SizedBox(height: 8),
                                ElevatedButton(
                                  onPressed: _fetchAttendance,
                                  child: const Text('Retry'),
                                ),
                              ],
                            ),
                          ),
                        )
                      else
                        _CalendarGrid(
                          displayedMonth: _displayedMonth,
                          memberJoinDate: widget.member.createdAt,
                          presentDates: _presentDates,
                        ),
                    ],
                  ),
                ),
              ),

              const SizedBox(height: 12),

              // ── Summary stats row ──────────────────────────────────────────
              if (!_loading && _error == null)
                _MonthSummaryBar(
                  month: _displayedMonth,
                  memberJoinDate: widget.member.createdAt,
                  presentDates: _presentDates,
                ),
            ],
          ),
        ),
      ),
    );
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'active':
        return const Color(0xFF4CAF50);
      case 'at_risk':
        return const Color(0xFFFF9800);
      case 'high_risk':
        return const Color(0xFFF44336);
      default:
        return Colors.grey;
    }
  }
}

// ============================================================================
// MEMBER DETAILS CARD — 2 columns layout
// ============================================================================

class _MemberDetailsCard extends StatelessWidget {
  final Customer member;
  final Color statusColor;

  const _MemberDetailsCard(
      {required this.member, required this.statusColor});

  @override
  Widget build(BuildContext context) {
    final expiry = DateFormat('dd MMM yyyy').format(member.subscriptionEndDate);
    final joined = DateFormat('dd MMM yyyy').format(member.createdAt);
    final lastVisit = member.lastVisitDate != null
        ? DateFormat('dd MMM yyyy').format(member.lastVisitDate!)
        : 'Never';

    return Card(
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Avatar + name + status chip
            Row(
              children: [
                CircleAvatar(
                  radius: 28,
                  backgroundColor: statusColor.withValues(alpha: 0.15),
                  child: Text(
                    member.name[0].toUpperCase(),
                    style: TextStyle(
                      color: statusColor,
                      fontWeight: FontWeight.bold,
                      fontSize: 22,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        member.name,
                        style: const TextStyle(
                            fontWeight: FontWeight.bold, fontSize: 17),
                      ),
                      const SizedBox(height: 4),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 3),
                        decoration: BoxDecoration(
                          color: statusColor.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(
                          member.statusDisplay,
                          style: TextStyle(
                              color: statusColor,
                              fontSize: 12,
                              fontWeight: FontWeight.bold),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),

            const Divider(height: 24),

            // 2-column detail grid
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Left column
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _DetailItem(
                          icon: Icons.phone,
                          label: 'Phone',
                          value: member.phone),
                      const SizedBox(height: 10),
                      _DetailItem(
                          icon: Icons.email_outlined,
                          label: 'Email',
                          value: member.email.isEmpty ? '—' : member.email),
                      const SizedBox(height: 10),
                      _DetailItem(
                          icon: Icons.calendar_month,
                          label: 'Joined',
                          value: joined),
                    ],
                  ),
                ),
                // Right column
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _DetailItem(
                          icon: Icons.currency_rupee,
                          label: 'Plan Fee',
                          value:
                              '₹${member.planFee.toStringAsFixed(0)}/month'),
                      const SizedBox(height: 10),
                      _DetailItem(
                          icon: Icons.event_busy,
                          label: 'Sub End',
                          value: expiry,
                          valueColor: member.daysUntilSubscriptionEnd < 0
                              ? Colors.red
                              : member.daysUntilSubscriptionEnd <= 7
                                  ? Colors.orange
                                  : null),
                      const SizedBox(height: 10),
                      _DetailItem(
                          icon: Icons.fitness_center,
                          label: 'Last Visit',
                          value: lastVisit),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _DetailItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color? valueColor;

  const _DetailItem({
    required this.icon,
    required this.label,
    required this.value,
    this.valueColor,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 15, color: Colors.grey[500]),
        const SizedBox(width: 5),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label,
                  style: TextStyle(
                      fontSize: 10,
                      color: Colors.grey[500],
                      fontWeight: FontWeight.w500)),
              Text(
                value,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: valueColor ?? Colors.black87,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

// ============================================================================
// MONTH NAVIGATION HEADER
// ============================================================================

class _MonthNavigationHeader extends StatelessWidget {
  final DateTime displayedMonth;
  final bool canGoPrev;
  final bool canGoNext;
  final VoidCallback onPrevious;
  final VoidCallback onNext;

  const _MonthNavigationHeader({
    required this.displayedMonth,
    required this.canGoPrev,
    required this.canGoNext,
    required this.onPrevious,
    required this.onNext,
  });

  @override
  Widget build(BuildContext context) {
    final label = DateFormat('MMMM yyyy').format(displayedMonth);
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          'Attendance',
          style: Theme.of(context)
              .textTheme
              .titleMedium
              ?.copyWith(fontWeight: FontWeight.bold),
        ),
        Row(
          children: [
            IconButton(
              icon: const Icon(Icons.chevron_left),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
              onPressed: canGoPrev ? onPrevious : null,
              color: canGoPrev ? Colors.black87 : Colors.grey[300],
            ),
            const SizedBox(width: 4),
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              decoration: BoxDecoration(
                color: const Color(0xFF2196F3).withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Text(
                label,
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 13,
                  color: Color(0xFF2196F3),
                ),
              ),
            ),
            const SizedBox(width: 4),
            IconButton(
              icon: const Icon(Icons.chevron_right),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
              onPressed: canGoNext ? onNext : null,
              color: canGoNext ? Colors.black87 : Colors.grey[300],
            ),
          ],
        ),
      ],
    );
  }
}

// ============================================================================
// LEGEND ROW
// ============================================================================

class _CalendarLegend extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _LegendDot(color: const Color(0xFF4CAF50), label: 'Present'),
        const SizedBox(width: 16),
        _LegendDot(color: const Color(0xFFF44336), label: 'Absent'),
        const SizedBox(width: 16),
        _LegendDot(color: Colors.grey[200]!, label: 'No data'),
      ],
    );
  }
}

class _LegendDot extends StatelessWidget {
  final Color color;
  final String label;

  const _LegendDot({required this.color, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 4),
        Text(label,
            style: TextStyle(fontSize: 11, color: Colors.grey[600])),
      ],
    );
  }
}

// ============================================================================
// CALENDAR GRID
// ============================================================================

class _CalendarGrid extends StatelessWidget {
  final DateTime displayedMonth;
  final DateTime memberJoinDate;
  final Set<String> presentDates;

  static const _weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const _CalendarGrid({
    required this.displayedMonth,
    required this.memberJoinDate,
    required this.presentDates,
  });

  /// ISO padded date string for a given day in the displayed month
  String _dateKey(int day) {
    final m = displayedMonth.month.toString().padLeft(2, '0');
    final d = day.toString().padLeft(2, '0');
    return '${displayedMonth.year}-$m-$d';
  }

  @override
  Widget build(BuildContext context) {
    final firstDayOfMonth =
        DateTime(displayedMonth.year, displayedMonth.month, 1);
    final daysInMonth =
        DateTime(displayedMonth.year, displayedMonth.month + 1, 0).day;

    // weekday: Mon=1 … Sun=7. We want col 0 = Mon → offset = weekday - 1
    final startOffset = firstDayOfMonth.weekday - 1;

    final today = DateTime.now();

    return Column(
      children: [
        // Weekday header row
        Row(
          children: _weekDays
              .map((d) => Expanded(
                    child: Center(
                      child: Text(
                        d,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                          color: d == 'Sun'
                              ? Colors.red[300]
                              : Colors.grey[600],
                        ),
                      ),
                    ),
                  ))
              .toList(),
        ),
        const SizedBox(height: 6),
        // Day cells
        GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 7,
            mainAxisSpacing: 6,
            crossAxisSpacing: 6,
            childAspectRatio: 1.0,
          ),
          itemCount: startOffset + daysInMonth,
          itemBuilder: (context, index) {
            if (index < startOffset) {
              // Empty spacer before the first day
              return const SizedBox.shrink();
            }

            final day = index - startOffset + 1;
            final cellDate =
                DateTime(displayedMonth.year, displayedMonth.month, day);
            final dateStr = _dateKey(day);

            // Determine cell state
            final isPresent = presentDates.contains(dateStr);
            final isFuture = cellDate.isAfter(today);
            final isBeforeJoin = cellDate
                .isBefore(DateTime(memberJoinDate.year, memberJoinDate.month, memberJoinDate.day));
            // For cells in the current month: only mark absent if day has passed
            final isPast = !isFuture && !isBeforeJoin;
            final isToday = cellDate.year == today.year &&
                cellDate.month == today.month &&
                cellDate.day == today.day;

            final bool showPresent = isPresent;
            final bool showAbsent =
                isPast && !isPresent && !isBeforeJoin && !isFuture;

            Color bgColor;
            Color textColor;

            if (showPresent) {
              bgColor = const Color(0xFF4CAF50);
              textColor = Colors.white;
            } else if (showAbsent) {
              bgColor = const Color(0xFFF44336);
              textColor = Colors.white;
            } else {
              bgColor = Colors.grey[100]!;
              textColor = Colors.grey[400]!;
            }

            return Container(
              decoration: BoxDecoration(
                color: bgColor,
                borderRadius: BorderRadius.circular(8),
                border: isToday
                    ? Border.all(color: Colors.black87, width: 2)
                    : null,
              ),
              child: Center(
                child: Text(
                  '$day',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight:
                        isToday ? FontWeight.bold : FontWeight.w500,
                    color: textColor,
                  ),
                ),
              ),
            );
          },
        ),
      ],
    );
  }
}

// ============================================================================
// MONTH SUMMARY BAR
// ============================================================================

class _MonthSummaryBar extends StatelessWidget {
  final DateTime month;
  final DateTime memberJoinDate;
  final Set<String> presentDates;

  const _MonthSummaryBar({
    required this.month,
    required this.memberJoinDate,
    required this.presentDates,
  });

  @override
  Widget build(BuildContext context) {
    final today = DateTime.now();
    final daysInMonth =
        DateTime(month.year, month.month + 1, 0).day;

    // Count past days in the month that fall within the member's tenure
    int relevantDays = 0;
    for (int d = 1; d <= daysInMonth; d++) {
      final date = DateTime(month.year, month.month, d);
      if (date.isAfter(today)) break;
      if (date.isBefore(
          DateTime(memberJoinDate.year, memberJoinDate.month, memberJoinDate.day))) {
        continue;
      }
      relevantDays++;
    }

    final presentCount = presentDates.length;
    final absentCount = (relevantDays - presentCount).clamp(0, relevantDays);
    final attendancePct =
        relevantDays > 0 ? (presentCount / relevantDays * 100).round() : 0;

    return Card(
      elevation: 2,
      shape:
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            _SummaryItem(
              label: 'Present',
              value: '$presentCount',
              color: const Color(0xFF4CAF50),
              icon: Icons.check_circle,
            ),
            _SummaryDivider(),
            _SummaryItem(
              label: 'Absent',
              value: '$absentCount',
              color: const Color(0xFFF44336),
              icon: Icons.cancel,
            ),
            _SummaryDivider(),
            _SummaryItem(
              label: 'Attendance',
              value: '$attendancePct%',
              color: attendancePct >= 75
                  ? const Color(0xFF4CAF50)
                  : attendancePct >= 50
                      ? Colors.orange
                      : const Color(0xFFF44336),
              icon: Icons.bar_chart,
            ),
          ],
        ),
      ),
    );
  }
}

class _SummaryItem extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  final IconData icon;

  const _SummaryItem({
    required this.label,
    required this.value,
    required this.color,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, color: color, size: 20),
        const SizedBox(height: 4),
        Text(value,
            style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 18,
                color: color)),
        Text(label,
            style: TextStyle(
                fontSize: 11, color: Colors.grey[600])),
      ],
    );
  }
}

class _SummaryDivider extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      height: 36,
      width: 1,
      color: Colors.grey[200],
    );
  }
}
