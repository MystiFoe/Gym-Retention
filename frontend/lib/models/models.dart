// ============================================================================
// AUTH MODELS
// ============================================================================

class LoginResponse {
  final String accessToken;
  final String refreshToken;
  final User user;

  LoginResponse({
    required this.accessToken,
    required this.refreshToken,
    required this.user,
  });

  factory LoginResponse.fromJson(Map<String, dynamic> json) {
    return LoginResponse(
      accessToken: json['accessToken'] ?? '',
      refreshToken: json['refreshToken'] ?? '',
      user: User.fromJson(json['user'] ?? {}),
    );
  }
}

class User {
  final String id;
  final String gymId;
  final String role;

  User({
    required this.id,
    required this.gymId,
    required this.role,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'] ?? '',
      gymId: json['gym_id'] ?? '',
      role: json['role'] ?? '',
    );
  }
}

// ============================================================================
// GYM MODELS
// ============================================================================

class GymRegistrationResponse {
  final String gymId;
  final DateTime trialEndsAt;

  GymRegistrationResponse({
    required this.gymId,
    required this.trialEndsAt,
  });

  factory GymRegistrationResponse.fromJson(Map<String, dynamic> json) {
    return GymRegistrationResponse(
      gymId: json['gymId'] ?? '',
      trialEndsAt: DateTime.parse(json['trialEndsAt'] ?? DateTime.now().toString()),
    );
  }
}

class BillingPlan {
  final String id;
  final String label;
  final int amountInPaise;
  final String amountDisplay;
  final int months;

  BillingPlan({
    required this.id,
    required this.label,
    required this.amountInPaise,
    required this.amountDisplay,
    required this.months,
  });

  factory BillingPlan.fromJson(Map<String, dynamic> json) => BillingPlan(
    id: json['id'] ?? '',
    label: json['label'] ?? '',
    amountInPaise: json['amountInPaise'] ?? 0,
    amountDisplay: json['amountDisplay'] ?? '',
    months: json['months'] ?? 1,
  );
}

class GymSubscriptionResponse {
  final String status;
  final int daysRemaining;
  final DateTime? trialEndsAt;
  final DateTime? subscriptionEndsAt;
  final List<BillingPlan> plans;

  GymSubscriptionResponse({
    required this.status,
    required this.daysRemaining,
    this.trialEndsAt,
    this.subscriptionEndsAt,
    required this.plans,
  });

  factory GymSubscriptionResponse.fromJson(Map<String, dynamic> json) {
    return GymSubscriptionResponse(
      status: json['status'] ?? '',
      daysRemaining: json['daysRemaining'] ?? 0,
      trialEndsAt: json['trialEndsAt'] != null ? DateTime.tryParse(json['trialEndsAt']) : null,
      subscriptionEndsAt: json['subscriptionEndsAt'] != null ? DateTime.tryParse(json['subscriptionEndsAt']) : null,
      plans: (json['plans'] as List<dynamic>? ?? []).map((p) => BillingPlan.fromJson(p)).toList(),
    );
  }
}

class RazorpayOrderResponse {
  final String orderId;
  final int amount;
  final String currency;
  final String keyId;
  final String gymName;
  final String planLabel;

  RazorpayOrderResponse({
    required this.orderId,
    required this.amount,
    required this.currency,
    required this.keyId,
    required this.gymName,
    required this.planLabel,
  });

  factory RazorpayOrderResponse.fromJson(Map<String, dynamic> json) => RazorpayOrderResponse(
    orderId: json['orderId'] ?? '',
    amount: json['amount'] ?? 0,
    currency: json['currency'] ?? 'INR',
    keyId: json['keyId'] ?? '',
    gymName: json['gymName'] ?? '',
    planLabel: json['planLabel'] ?? '',
  );
}

// ============================================================================
// MEMBER MODELS
// ============================================================================

class Member {
  final String id;
  final String name;
  final String phone;
  final String email;
  final DateTime? lastVisitDate;
  final DateTime membershipExpiryDate;
  final double planFee;
  final String status;
  final DateTime createdAt;
  final String? assignedTrainerId;

  Member({
    required this.id,
    required this.name,
    required this.phone,
    required this.email,
    this.lastVisitDate,
    required this.membershipExpiryDate,
    required this.planFee,
    required this.status,
    required this.createdAt,
    this.assignedTrainerId,
  });

  factory Member.fromJson(Map<String, dynamic> json) {
    return Member(
      id: json['id'] ?? '',
      name: json['name'] ?? '',
      phone: json['phone'] ?? '',
      email: json['email'] ?? '',
      lastVisitDate: json['last_visit_date'] != null
          ? DateTime.parse(json['last_visit_date'])
          : null,
      membershipExpiryDate: DateTime.parse(json['membership_expiry_date'] ?? DateTime.now().toString()),
      planFee: double.tryParse(json['plan_fee'].toString()) ?? 0.0,
      status: json['status'] ?? 'active',
      createdAt: DateTime.parse(json['created_at'] ?? DateTime.now().toString()),
      assignedTrainerId: json['assigned_trainer_id'],
    );
  }

  int get daysUntilExpiry {
    return membershipExpiryDate.difference(DateTime.now()).inDays;
  }

  int get daysSinceLastVisit {
    if (lastVisitDate == null) return 999;
    return DateTime.now().difference(lastVisitDate!).inDays;
  }

  String get statusDisplay {
    switch (status) {
      case 'active': return 'Active';
      case 'at_risk': return 'At Risk';
      case 'high_risk': return 'High Risk';
      default: return 'Active';
    }
  }
}

class MembersResponse {
  final List<Member> members;
  final int total;
  final int page;
  final int pages;

  MembersResponse({
    required this.members,
    required this.total,
    required this.page,
    required this.pages,
  });

  factory MembersResponse.fromJson(Map<String, dynamic> json) {
    return MembersResponse(
      members: (json['members'] as List?)
          ?.map((m) => Member.fromJson(m))
          .toList() ??
          [],
      total: json['total'] ?? 0,
      page: json['page'] ?? 1,
      pages: json['pages'] ?? 1,
    );
  }
}

// ============================================================================
// TRAINER MODELS
// ============================================================================

class Trainer {
  final String id;
  final String name;
  final String phone;
  final String email;
  final int assignedMembersCount;
  final bool isActive;
  final DateTime createdAt;

  Trainer({
    required this.id,
    required this.name,
    required this.phone,
    required this.email,
    required this.assignedMembersCount,
    required this.isActive,
    required this.createdAt,
  });

  factory Trainer.fromJson(Map<String, dynamic> json) {
    return Trainer(
      id: json['id'] ?? '',
      name: json['name'] ?? '',
      phone: json['phone'] ?? '',
      email: json['email'] ?? '',
      assignedMembersCount: json['assigned_members_count'] ?? 0,
      isActive: json['is_active'] ?? true,
      createdAt: json['created_at'] != null
          ? DateTime.parse(json['created_at'])
          : DateTime.now(),
    );
  }
}

class TrainersResponse {
  final List<Trainer> trainers;

  TrainersResponse({required this.trainers});

  factory TrainersResponse.fromJson(Map<String, dynamic> json) {
    return TrainersResponse(
      trainers: (json['trainers'] as List?)
              ?.map((t) => Trainer.fromJson(t))
              .toList() ??
          [],
    );
  }
}

// ============================================================================
// TASK MODELS
// ============================================================================

class Task {
  final String id;
  final String memberId;
  final String taskType;
  final String status;
  final String? outcome;
  final String? notes;
  final DateTime createdAt;
  final DateTime? completedAt;
  final String? assignedTrainerId;
  final String? memberName;
  final String? memberPhone;
  final String? trainerName;

  Task({
    required this.id,
    required this.memberId,
    required this.taskType,
    required this.status,
    this.outcome,
    this.notes,
    required this.createdAt,
    this.completedAt,
    this.assignedTrainerId,
    this.memberName,
    this.memberPhone,
    this.trainerName,
  });

  factory Task.fromJson(Map<String, dynamic> json) {
    return Task(
      id: json['id'] ?? '',
      memberId: json['member_id'] ?? '',
      taskType: json['task_type'] ?? '',
      status: json['status'] ?? '',
      outcome: json['outcome'],
      notes: json['notes'],
      createdAt: DateTime.parse(json['created_at'] ?? DateTime.now().toString()),
      completedAt: json['completed_at'] != null
          ? DateTime.parse(json['completed_at'])
          : null,
      assignedTrainerId: json['assigned_trainer_id'],
      memberName: json['member_name'],
      memberPhone: json['member_phone'],
      trainerName: json['trainer_name'],
    );
  }
}

class TasksResponse {
  final List<Task> tasks;

  TasksResponse({required this.tasks});

  factory TasksResponse.fromJson(Map<String, dynamic> json) {
    return TasksResponse(
      tasks: (json['tasks'] as List?)
          ?.map((t) => Task.fromJson(t))
          .toList() ??
          [],
    );
  }
}

// ============================================================================
// ATTENDANCE MODELS
// ============================================================================

class AttendanceRecord {
  final String id;
  final String memberId;
  final DateTime visitDate;
  final String? checkInTime;
  final DateTime createdAt;

  AttendanceRecord({
    required this.id,
    required this.memberId,
    required this.visitDate,
    this.checkInTime,
    required this.createdAt,
  });

  factory AttendanceRecord.fromJson(Map<String, dynamic> json) {
    return AttendanceRecord(
      id: json['id'] ?? '',
      memberId: json['member_id'] ?? '',
      visitDate: DateTime.parse(json['visit_date'] ?? DateTime.now().toString()),
      checkInTime: json['check_in_time'],
      createdAt: DateTime.parse(json['created_at'] ?? DateTime.now().toString()),
    );
  }
}

class AttendanceResponse {
  final List<AttendanceRecord> attendance;

  AttendanceResponse({required this.attendance});

  factory AttendanceResponse.fromJson(Map<String, dynamic> json) {
    return AttendanceResponse(
      attendance: (json['attendance'] as List?)
          ?.map((a) => AttendanceRecord.fromJson(a))
          .toList() ??
          [],
    );
  }
}

// ============================================================================
// DASHBOARD MODELS
// ============================================================================

class DashboardKPIs {
  final int totalMembers;
  final int activeMembers;
  final int atRiskMembers;
  final int highRiskMembers;
  final double revenueRecovered;

  DashboardKPIs({
    required this.totalMembers,
    required this.activeMembers,
    required this.atRiskMembers,
    required this.highRiskMembers,
    this.revenueRecovered = 0.0,
  });

  factory DashboardKPIs.fromJson(Map<String, dynamic> json) {
    return DashboardKPIs(
      totalMembers: json['totalMembers'] ?? 0,
      activeMembers: json['activeMembers'] ?? 0,
      atRiskMembers: json['atRiskMembers'] ?? 0,
      highRiskMembers: json['highRiskMembers'] ?? 0,
      revenueRecovered: double.tryParse(json['revenueRecovered']?.toString() ?? '0') ?? 0.0,
    );
  }

  double get activePercentage {
    if (totalMembers == 0) return 0;
    return (activeMembers / totalMembers) * 100;
  }
}

// ============================================================================
// REVENUE MODELS
// ============================================================================

class RevenueRecord {
  final DateTime month;
  final double total;
  final int count;

  RevenueRecord({
    required this.month,
    required this.total,
    required this.count,
  });

  factory RevenueRecord.fromJson(Map<String, dynamic> json) {
    return RevenueRecord(
      month: DateTime.parse(json['month'] ?? DateTime.now().toString()),
      total: double.tryParse(json['total'].toString()) ?? 0.0,
      count: json['count'] ?? 0,
    );
  }
}

class RevenueDetailRecord {
  final String id;
  final String memberId;
  final String memberName;
  final double revenueRecovered;
  final DateTime trackedAt;

  RevenueDetailRecord({
    required this.id,
    required this.memberId,
    required this.memberName,
    required this.revenueRecovered,
    required this.trackedAt,
  });

  factory RevenueDetailRecord.fromJson(Map<String, dynamic> json) {
    return RevenueDetailRecord(
      id: json['id'] ?? '',
      memberId: json['member_id'] ?? '',
      memberName: json['member_name'] ?? 'Unknown',
      revenueRecovered: double.tryParse(json['revenue_recovered'].toString()) ?? 0.0,
      trackedAt: DateTime.parse(json['tracked_at'] ?? DateTime.now().toString()),
    );
  }
}

class RevenueMetrics {
  final int totalRecoveredMembers;
  final double totalRevenueRecovered;
  final double revenueThisMonth;
  final double revenueThisYear;

  RevenueMetrics({
    required this.totalRecoveredMembers,
    required this.totalRevenueRecovered,
    required this.revenueThisMonth,
    required this.revenueThisYear,
  });

  factory RevenueMetrics.fromJson(Map<String, dynamic> json) {
    return RevenueMetrics(
      totalRecoveredMembers: json['totalRecoveredMembers'] ?? 0,
      totalRevenueRecovered: double.tryParse(json['totalRevenueRecovered'].toString()) ?? 0.0,
      revenueThisMonth: double.tryParse(json['revenueThisMonth'].toString()) ?? 0.0,
      revenueThisYear: double.tryParse(json['revenueThisYear'].toString()) ?? 0.0,
    );
  }
}

// ============================================================================
// ADMIN MODELS
// ============================================================================

class AdminGym {
  final String id;
  final String name;
  final String email;
  final String phone;
  final String ownerName;
  final String subscriptionStatus;
  final int daysRemaining;
  final int memberCount;
  final DateTime createdAt;
  final DateTime? trialEndsAt;
  final DateTime? subscriptionEndsAt;

  AdminGym({
    required this.id,
    required this.name,
    required this.email,
    required this.phone,
    required this.ownerName,
    required this.subscriptionStatus,
    required this.daysRemaining,
    required this.memberCount,
    required this.createdAt,
    this.trialEndsAt,
    this.subscriptionEndsAt,
  });

  factory AdminGym.fromJson(Map<String, dynamic> json) => AdminGym(
    id: json['id'] ?? '',
    name: json['name'] ?? '',
    email: json['email'] ?? '',
    phone: json['phone'] ?? '',
    ownerName: json['owner_name'] ?? '',
    subscriptionStatus: json['subscription_status'] ?? 'trial',
    daysRemaining: int.tryParse(json['days_remaining']?.toString() ?? '0') ?? 0,
    memberCount: int.tryParse(json['member_count']?.toString() ?? '0') ?? 0,
    createdAt: DateTime.tryParse(json['created_at'] ?? '') ?? DateTime.now(),
    trialEndsAt: json['trial_ends_at'] != null ? DateTime.tryParse(json['trial_ends_at']) : null,
    subscriptionEndsAt: json['subscription_ends_at'] != null ? DateTime.tryParse(json['subscription_ends_at']) : null,
  );
}

class RevenueResponse {
  final List<RevenueRecord> revenue;
  final List<RevenueDetailRecord> revenueRecords;
  final RevenueMetrics? metrics;

  RevenueResponse({required this.revenue, required this.revenueRecords, this.metrics});

  factory RevenueResponse.fromJson(Map<String, dynamic> json) {
    return RevenueResponse(
      revenue: (json['revenue'] as List?)
          ?.map((r) => RevenueRecord.fromJson(r))
          .toList() ?? [],
      revenueRecords: (json['revenueRecords'] as List?)
          ?.map((r) => RevenueDetailRecord.fromJson(r))
          .toList() ?? [],
      metrics: json['metrics'] != null ? RevenueMetrics.fromJson(json['metrics']) : null,
    );
  }

  double get totalRevenue {
    return revenue.fold(0, (sum, r) => sum + r.total);
  }
}
