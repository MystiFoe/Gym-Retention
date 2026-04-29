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
  final String businessId;
  final String role;

  User({
    required this.id,
    required this.businessId,
    required this.role,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'] ?? '',
      businessId: json['gym_id'] ?? '',
      role: json['role'] ?? '',
    );
  }
}

// ============================================================================
// BUSINESS MODELS
// ============================================================================

/// Returned by POST /api/business/register — registration is NOT complete yet.
/// The user must verify email then phone before a business/user record is created.
class BusinessRegistrationResponse {
  final String pendingId;
  final String ownerEmail;
  final String businessPhone;

  BusinessRegistrationResponse({
    required this.pendingId,
    required this.ownerEmail,
    required this.businessPhone,
  });

  factory BusinessRegistrationResponse.fromJson(Map<String, dynamic> json) {
    return BusinessRegistrationResponse(
      pendingId:     json['pendingId']  ?? '',
      ownerEmail:    json['ownerEmail'] ?? '',
      businessPhone: json['gymPhone']   ?? '',
    );
  }
}

/// Returned by POST /api/business/register/verify-email — email confirmed.
class RegistrationEmailVerifyResponse {
  final String pendingId;
  final String businessPhone;

  RegistrationEmailVerifyResponse({required this.pendingId, required this.businessPhone});

  factory RegistrationEmailVerifyResponse.fromJson(Map<String, dynamic> json) {
    return RegistrationEmailVerifyResponse(
      pendingId:     json['pendingId'] ?? '',
      businessPhone: json['gymPhone']  ?? '',
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

class BusinessSubscriptionResponse {
  final String status;
  final int daysRemaining;
  final DateTime? trialEndsAt;
  final DateTime? subscriptionEndsAt;
  final List<BillingPlan> plans;

  BusinessSubscriptionResponse({
    required this.status,
    required this.daysRemaining,
    this.trialEndsAt,
    this.subscriptionEndsAt,
    required this.plans,
  });

  factory BusinessSubscriptionResponse.fromJson(Map<String, dynamic> json) {
    return BusinessSubscriptionResponse(
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
  final String businessName;
  final String planLabel;

  RazorpayOrderResponse({
    required this.orderId,
    required this.amount,
    required this.currency,
    required this.keyId,
    required this.businessName,
    required this.planLabel,
  });

  factory RazorpayOrderResponse.fromJson(Map<String, dynamic> json) => RazorpayOrderResponse(
    orderId:      json['orderId']    ?? '',
    amount:       json['amount']     ?? 0,
    currency:     json['currency']   ?? 'INR',
    keyId:        json['keyId']      ?? '',
    businessName: json['gymName']    ?? '',
    planLabel:    json['planLabel']  ?? '',
  );
}

// ============================================================================
// CUSTOMER MODELS
// ============================================================================

class Customer {
  final String id;
  final String name;
  final String phone;
  final String email;
  final DateTime? lastVisitDate;
  final DateTime subscriptionEndDate;
  final double planFee;
  final String status;
  final DateTime createdAt;
  final String? assignedStaffId;

  Customer({
    required this.id,
    required this.name,
    required this.phone,
    required this.email,
    this.lastVisitDate,
    required this.subscriptionEndDate,
    required this.planFee,
    required this.status,
    required this.createdAt,
    this.assignedStaffId,
  });

  factory Customer.fromJson(Map<String, dynamic> json) {
    return Customer(
      id: json['id'] ?? '',
      name: json['name'] ?? '',
      phone: json['phone'] ?? '',
      email: json['email'] ?? '',
      lastVisitDate: json['last_visit_date'] != null
          ? DateTime.parse(json['last_visit_date'])
          : null,
      subscriptionEndDate: DateTime.parse(json['membership_expiry_date'] ?? DateTime.now().toString()),
      planFee: double.tryParse(json['plan_fee'].toString()) ?? 0.0,
      status: json['status'] ?? 'active',
      createdAt: DateTime.parse(json['created_at'] ?? DateTime.now().toString()),
      assignedStaffId: json['assigned_trainer_id'],
    );
  }

  int get daysUntilSubscriptionEnd {
    return subscriptionEndDate.difference(DateTime.now()).inDays;
  }

  int get daysSinceLastVisit {
    if (lastVisitDate == null) return 999;
    return DateTime.now().difference(lastVisitDate!).inDays;
  }

  String get statusDisplay {
    switch (status) {
      case 'active':    return 'Active';
      case 'at_risk':   return 'At Risk';
      case 'high_risk': return 'High Risk';
      default:          return 'Active';
    }
  }
}

class CustomersResponse {
  final List<Customer> customers;
  final int total;
  final int page;
  final int pages;

  CustomersResponse({
    required this.customers,
    required this.total,
    required this.page,
    required this.pages,
  });

  factory CustomersResponse.fromJson(Map<String, dynamic> json) {
    return CustomersResponse(
      customers: (json['members'] as List?)
          ?.map((m) => Customer.fromJson(m))
          .toList() ??
          [],
      total: json['total'] ?? 0,
      page:  json['page']  ?? 1,
      pages: json['pages'] ?? 1,
    );
  }
}

// ============================================================================
// STAFF MODELS
// ============================================================================

class Staff {
  final String id;
  final String name;
  final String phone;
  final String email;
  final int assignedCustomersCount;
  final bool isActive;
  final DateTime createdAt;

  Staff({
    required this.id,
    required this.name,
    required this.phone,
    required this.email,
    required this.assignedCustomersCount,
    required this.isActive,
    required this.createdAt,
  });

  factory Staff.fromJson(Map<String, dynamic> json) {
    return Staff(
      id: json['id'] ?? '',
      name: json['name'] ?? '',
      phone: json['phone'] ?? '',
      email: json['email'] ?? '',
      assignedCustomersCount: json['assigned_members_count'] ?? 0,
      isActive: json['is_active'] ?? true,
      createdAt: json['created_at'] != null
          ? DateTime.parse(json['created_at'])
          : DateTime.now(),
    );
  }
}

class StaffResponse {
  final List<Staff> staff;
  final int total;
  final int page;
  final int pages;

  StaffResponse({
    required this.staff,
    this.total = 0,
    this.page = 1,
    this.pages = 1,
  });

  factory StaffResponse.fromJson(Map<String, dynamic> json) {
    return StaffResponse(
      staff: (json['trainers'] as List?)
              ?.map((t) => Staff.fromJson(t))
              .toList() ??
          [],
      total: json['total'] ?? 0,
      page:  json['page']  ?? 1,
      pages: json['pages'] ?? 1,
    );
  }
}

// ============================================================================
// TASK MODELS
// ============================================================================

class Task {
  final String id;
  final String customerId;
  final String taskType;
  final String status;
  final String? outcome;
  final String? notes;
  final DateTime createdAt;
  final DateTime? completedAt;
  final String? assignedStaffId;
  final String? customerName;
  final String? customerPhone;
  final String? staffName;

  Task({
    required this.id,
    required this.customerId,
    required this.taskType,
    required this.status,
    this.outcome,
    this.notes,
    required this.createdAt,
    this.completedAt,
    this.assignedStaffId,
    this.customerName,
    this.customerPhone,
    this.staffName,
  });

  factory Task.fromJson(Map<String, dynamic> json) {
    return Task(
      id:             json['id']             ?? '',
      customerId:     json['member_id']      ?? '',
      taskType:       json['task_type']      ?? '',
      status:         json['status']         ?? '',
      outcome:        json['outcome'],
      notes:          json['notes'],
      createdAt:      DateTime.parse(json['created_at'] ?? DateTime.now().toString()),
      completedAt:    json['completed_at'] != null ? DateTime.parse(json['completed_at']) : null,
      assignedStaffId: json['assigned_trainer_id'],
      customerName:   json['member_name'],
      customerPhone:  json['member_phone'],
      staffName:      json['trainer_name'],
    );
  }
}

class TasksResponse {
  final List<Task> tasks;
  final int total;
  final int page;
  final int pages;

  TasksResponse({
    required this.tasks,
    this.total = 0,
    this.page = 1,
    this.pages = 1,
  });

  factory TasksResponse.fromJson(Map<String, dynamic> json) {
    return TasksResponse(
      tasks: (json['tasks'] as List?)
          ?.map((t) => Task.fromJson(t))
          .toList() ??
          [],
      total: json['total'] ?? 0,
      page:  json['page']  ?? 1,
      pages: json['pages'] ?? 1,
    );
  }
}

// ============================================================================
// ATTENDANCE MODELS
// ============================================================================

class AttendanceRecord {
  final String id;
  final String customerId;
  final DateTime visitDate;
  final String? checkInTime;
  final DateTime createdAt;

  AttendanceRecord({
    required this.id,
    required this.customerId,
    required this.visitDate,
    this.checkInTime,
    required this.createdAt,
  });

  factory AttendanceRecord.fromJson(Map<String, dynamic> json) {
    return AttendanceRecord(
      id:          json['id']           ?? '',
      customerId:  json['member_id']    ?? '',
      visitDate:   DateTime.parse(json['visit_date'] ?? DateTime.now().toString()),
      checkInTime: json['check_in_time'],
      createdAt:   DateTime.parse(json['created_at'] ?? DateTime.now().toString()),
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
// CUSTOMER ATTENDANCE CALENDAR MODEL
// ============================================================================

/// Response for GET /api/customers/:customerId/attendance?month=YYYY-MM
/// Used by the customer attendance calendar screen.
class CustomerAttendanceResponse {
  /// Full customer details
  final Customer customer;

  /// Dates (YYYY-MM-DD) where the customer was present this month
  final List<String> presentDates;

  /// The month this data covers, in YYYY-MM format
  final String month;

  CustomerAttendanceResponse({
    required this.customer,
    required this.presentDates,
    required this.month,
  });

  factory CustomerAttendanceResponse.fromJson(Map<String, dynamic> json) {
    return CustomerAttendanceResponse(
      customer:     Customer.fromJson(json['member'] ?? {}),
      presentDates: (json['present_dates'] as List<dynamic>? ?? [])
          .map((d) => d.toString())
          .toList(),
      month: json['month'] ?? '',
    );
  }
}

// ============================================================================
// DASHBOARD MODELS
// ============================================================================

class DashboardKPIs {
  final int totalCustomers;
  final int activeCustomers;
  final int atRiskCustomers;
  final int highRiskCustomers;
  final double revenueRecovered;

  DashboardKPIs({
    required this.totalCustomers,
    required this.activeCustomers,
    required this.atRiskCustomers,
    required this.highRiskCustomers,
    this.revenueRecovered = 0.0,
  });

  factory DashboardKPIs.fromJson(Map<String, dynamic> json) {
    return DashboardKPIs(
      totalCustomers:    json['totalMembers']    ?? 0,
      activeCustomers:   json['activeMembers']   ?? 0,
      atRiskCustomers:   json['atRiskMembers']   ?? 0,
      highRiskCustomers: json['highRiskMembers'] ?? 0,
      revenueRecovered:  double.tryParse(json['revenueRecovered']?.toString() ?? '0') ?? 0.0,
    );
  }

  double get activePercentage {
    if (totalCustomers == 0) return 0;
    return (activeCustomers / totalCustomers) * 100;
  }
}

// ============================================================================
// PROFILE MODELS
// ============================================================================

class GymProfile {
  final String id;
  final String name;
  final String address;
  final String phone;
  final String email;

  GymProfile({
    required this.id,
    required this.name,
    required this.address,
    required this.phone,
    required this.email,
  });

  factory GymProfile.fromJson(Map<String, dynamic> json) => GymProfile(
    id:      json['id']      ?? '',
    name:    json['name']    ?? '',
    address: json['address'] ?? '',
    phone:   json['phone']   ?? '',
    email:   json['email']   ?? '',
  );
}

class UserProfile {
  final String id;
  final String name;
  final String email;
  final String phone;
  final bool phoneVerified;
  final String role;
  final GymProfile? gym;

  UserProfile({
    required this.id,
    required this.name,
    required this.email,
    required this.phone,
    required this.phoneVerified,
    required this.role,
    this.gym,
  });

  factory UserProfile.fromJson(Map<String, dynamic> json) => UserProfile(
    id:            json['id']            ?? '',
    name:          json['name']          ?? '',
    email:         json['email']         ?? '',
    phone:         json['phone']         ?? '',
    phoneVerified: json['phoneVerified'] ?? false,
    role:          json['role']          ?? '',
    gym:           json['gym'] != null ? GymProfile.fromJson(json['gym']) : null,
  );
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
  final String customerId;
  final String customerName;
  final double revenueRecovered;
  final DateTime trackedAt;

  RevenueDetailRecord({
    required this.id,
    required this.customerId,
    required this.customerName,
    required this.revenueRecovered,
    required this.trackedAt,
  });

  factory RevenueDetailRecord.fromJson(Map<String, dynamic> json) {
    return RevenueDetailRecord(
      id:               json['id']                ?? '',
      customerId:       json['member_id']         ?? '',
      customerName:     json['member_name']       ?? 'Unknown',
      revenueRecovered: double.tryParse(json['revenue_recovered'].toString()) ?? 0.0,
      trackedAt:        DateTime.parse(json['tracked_at'] ?? DateTime.now().toString()),
    );
  }
}

class RevenueMetrics {
  final int totalRecoveredCustomers;
  final double totalRevenueRecovered;
  final double revenueThisMonth;
  final double revenueThisYear;

  RevenueMetrics({
    required this.totalRecoveredCustomers,
    required this.totalRevenueRecovered,
    required this.revenueThisMonth,
    required this.revenueThisYear,
  });

  factory RevenueMetrics.fromJson(Map<String, dynamic> json) {
    return RevenueMetrics(
      totalRecoveredCustomers: json['totalRecoveredMembers'] ?? 0,
      totalRevenueRecovered:   double.tryParse(json['totalRevenueRecovered'].toString()) ?? 0.0,
      revenueThisMonth:        double.tryParse(json['revenueThisMonth'].toString()) ?? 0.0,
      revenueThisYear:         double.tryParse(json['revenueThisYear'].toString()) ?? 0.0,
    );
  }
}

// ============================================================================
// ADMIN MODELS
// ============================================================================

class AdminBusiness {
  final String id;
  final String name;
  final String email;
  final String phone;
  final String ownerName;
  final String subscriptionStatus;
  final int daysRemaining;
  final int customerCount;
  final DateTime createdAt;
  final DateTime? trialEndsAt;
  final DateTime? subscriptionEndsAt;

  AdminBusiness({
    required this.id,
    required this.name,
    required this.email,
    required this.phone,
    required this.ownerName,
    required this.subscriptionStatus,
    required this.daysRemaining,
    required this.customerCount,
    required this.createdAt,
    this.trialEndsAt,
    this.subscriptionEndsAt,
  });

  factory AdminBusiness.fromJson(Map<String, dynamic> json) => AdminBusiness(
    id:                 json['id']                  ?? '',
    name:               json['name']                ?? '',
    email:              json['email']               ?? '',
    phone:              json['phone']               ?? '',
    ownerName:          json['owner_name']          ?? '',
    subscriptionStatus: json['subscription_status'] ?? 'trial',
    daysRemaining:      int.tryParse(json['days_remaining']?.toString()  ?? '0') ?? 0,
    customerCount:      int.tryParse(json['member_count']?.toString()    ?? '0') ?? 0,
    createdAt:          DateTime.tryParse(json['created_at'] ?? '')              ?? DateTime.now(),
    trialEndsAt:        json['trial_ends_at']       != null ? DateTime.tryParse(json['trial_ends_at'])       : null,
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
