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
  final String trainerRole; // 'staff' | 'admin' — only relevant when role == 'trainer'

  User({
    required this.id,
    required this.businessId,
    required this.role,
    this.trainerRole = 'staff',
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id:          json['id']           ?? '',
      businessId:  json['gym_id']       ?? '',
      role:        json['role']         ?? '',
      trainerRole: json['trainer_role'] ?? 'staff',
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

// Shared plan definitions — single source of truth used across all screens
class MemberPlan {
  final String key;
  final String label;
  final int months;
  const MemberPlan({required this.key, required this.label, required this.months});
}

const List<MemberPlan> kMemberPlans = [
  MemberPlan(key: 'monthly',   label: '1 Month',  months: 1),
  MemberPlan(key: 'quarterly', label: '3 Months', months: 3),
  MemberPlan(key: 'biannual',  label: '6 Months', months: 6),
  MemberPlan(key: 'annual',    label: '1 Year',   months: 12),
];

String planLabel(String? key) {
  if (key == null) return '—';
  return kMemberPlans.firstWhere((p) => p.key == key,
      orElse: () => MemberPlan(key: key, label: key, months: 1)).label;
}

class Customer {
  final String id;
  final String name;
  final String phone;
  final String email;
  final DateTime? lastVisitDate;
  final DateTime subscriptionEndDate;
  final double planFee;
  final String? plan;   // 'monthly' | 'quarterly' | 'biannual' | 'annual'
  final String status;
  final DateTime createdAt;
  final String? assignedStaffId;
  final String? displayId; // e.g. RCV-M-0000001

  Customer({
    required this.id,
    required this.name,
    required this.phone,
    required this.email,
    this.lastVisitDate,
    required this.subscriptionEndDate,
    required this.planFee,
    this.plan,
    required this.status,
    required this.createdAt,
    this.assignedStaffId,
    this.displayId,
  });

  String get planDisplay => planLabel(plan);

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
      plan: json['plan'],
      status: json['status'] ?? 'active',
      createdAt: DateTime.parse(json['created_at'] ?? DateTime.now().toString()),
      assignedStaffId: json['assigned_trainer_id'],
      displayId: json['display_id'],
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
  final String trainerRole; // 'staff' | 'admin'
  final String? displayId;  // e.g. RCV-S-0000001

  Staff({
    required this.id,
    required this.name,
    required this.phone,
    required this.email,
    required this.assignedCustomersCount,
    required this.isActive,
    required this.createdAt,
    this.trainerRole = 'staff',
    this.displayId,
  });

  bool get isAdmin => trainerRole == 'admin';

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
      trainerRole: json['trainer_role'] ?? 'staff',
      displayId: json['display_id'],
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
  final bool razorpayConfigured;
  final String? razorpayKeyHint; // first 8 chars of key ID, e.g. "rzp_test"

  GymProfile({
    required this.id,
    required this.name,
    required this.address,
    required this.phone,
    required this.email,
    this.razorpayConfigured = false,
    this.razorpayKeyHint,
  });

  factory GymProfile.fromJson(Map<String, dynamic> json) => GymProfile(
    id:                  json['id']                   ?? '',
    name:                json['name']                 ?? '',
    address:             json['address']              ?? '',
    phone:               json['phone']                ?? '',
    email:               json['email']                ?? '',
    razorpayConfigured:  json['razorpay_configured']  == true,
    razorpayKeyHint:     json['razorpay_key_hint'],
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

// ============================================================================
// CUSTOMER PORTAL MODELS
// ============================================================================

class CustomerLoginResponse {
  final String accessToken;
  final String memberId;
  final String gymId;
  final String gymName;
  final String name;
  final bool multiple;
  final List<Map<String, String>> gyms;
  final String? firebaseIdToken;

  CustomerLoginResponse({
    required this.accessToken,
    required this.memberId,
    required this.gymId,
    required this.gymName,
    required this.name,
    this.multiple = false,
    this.gyms = const [],
    this.firebaseIdToken,
  });

  factory CustomerLoginResponse.fromJson(Map<String, dynamic> json) {
    if (json['multiple'] == true) {
      return CustomerLoginResponse(
        accessToken: '',
        memberId: '',
        gymId: '',
        gymName: '',
        name: '',
        multiple: true,
        gyms: (json['gyms'] as List? ?? []).map((g) => {
          'member_id': g['member_id']?.toString() ?? '',
          'gym_id':    g['gym_id']?.toString()    ?? '',
          'gym_name':  g['gym_name']?.toString()  ?? '',
          'name':      g['name']?.toString()      ?? '',
        }).toList(),
        firebaseIdToken: json['firebase_id_token']?.toString(),
      );
    }
    final m = json['member'] as Map<String, dynamic>? ?? {};
    return CustomerLoginResponse(
      accessToken: json['access_token'] ?? '',
      memberId:    m['id']       ?? '',
      gymId:       m['gym_id']   ?? '',
      gymName:     m['gym_name'] ?? '',
      name:        m['name']     ?? '',
    );
  }
}

class CustomerProfile {
  final String id;
  final String name;
  final String phone;
  final String email;
  final String status;
  final DateTime? lastVisitDate;
  final DateTime membershipExpiryDate;
  final double planFee;
  final String? plan;
  final DateTime createdAt;
  final String gymName;
  final String gymAddress;
  final String gymPhone;
  final bool paymentEnabled;
  final bool emailVerified;
  final bool phoneVerified;

  CustomerProfile({
    required this.id,
    required this.name,
    required this.phone,
    required this.email,
    required this.status,
    this.lastVisitDate,
    required this.membershipExpiryDate,
    required this.planFee,
    this.plan,
    required this.createdAt,
    required this.gymName,
    required this.gymAddress,
    required this.gymPhone,
    required this.paymentEnabled,
    this.emailVerified = false,
    this.phoneVerified = false,
  });

  String get planDisplay => planLabel(plan);

  factory CustomerProfile.fromJson(Map<String, dynamic> json) => CustomerProfile(
    id:                   json['id']            ?? '',
    name:                 json['name']          ?? '',
    phone:                json['phone']         ?? '',
    email:                json['email']         ?? '',
    status:               json['status']        ?? 'active',
    lastVisitDate:        json['last_visit_date'] != null ? DateTime.tryParse(json['last_visit_date']) : null,
    membershipExpiryDate: DateTime.tryParse(json['membership_expiry_date'] ?? '') ?? DateTime.now(),
    planFee:              double.tryParse(json['plan_fee']?.toString() ?? '0') ?? 0,
    plan:                 json['plan'],
    createdAt:            DateTime.tryParse(json['created_at'] ?? '') ?? DateTime.now(),
    gymName:              json['gym_name']    ?? '',
    gymAddress:           json['gym_address'] ?? '',
    gymPhone:             json['gym_phone']   ?? '',
    paymentEnabled:       json['payment_enabled'] == true,
    emailVerified:        json['email_verified'] == true,
    phoneVerified:        json['phone_verified'] == true,
  );

  int get daysUntilExpiry => membershipExpiryDate.difference(DateTime.now()).inDays;
  int get daysSinceLastVisit => lastVisitDate == null ? 999 : DateTime.now().difference(lastVisitDate!).inDays;

  String get statusDisplay {
    switch (status) {
      case 'active':    return 'Active';
      case 'at_risk':   return 'At Risk';
      case 'high_risk': return 'High Risk';
      default:          return 'Active';
    }
  }
}

class Payment {
  final String id;
  final int amount; // paise
  final String currency;
  final String status;
  final String? paymentMethod;
  final String? description;
  final DateTime createdAt;
  final String? memberName;
  final String? memberPhone;

  Payment({
    required this.id,
    required this.amount,
    required this.currency,
    required this.status,
    this.paymentMethod,
    this.description,
    required this.createdAt,
    this.memberName,
    this.memberPhone,
  });

  factory Payment.fromJson(Map<String, dynamic> json) => Payment(
    id:            json['id']             ?? '',
    amount:        int.tryParse(json['amount']?.toString() ?? '0') ?? 0,
    currency:      json['currency']        ?? 'INR',
    status:        json['status']          ?? 'pending',
    paymentMethod: json['payment_method'],
    description:   json['description'],
    createdAt:     DateTime.tryParse(json['created_at'] ?? '') ?? DateTime.now(),
    memberName:    json['member_name'],
    memberPhone:   json['member_phone'],
  );

  double get amountRupees => amount / 100;
}

class PaymentsResponse {
  final List<Payment> payments;
  final int total;
  final int totalAmount; // paise

  PaymentsResponse({required this.payments, required this.total, this.totalAmount = 0});

  factory PaymentsResponse.fromJson(Map<String, dynamic> json) => PaymentsResponse(
    payments:    (json['payments'] as List? ?? []).map((p) => Payment.fromJson(p)).toList(),
    total:       int.tryParse(json['total']?.toString() ?? '0') ?? 0,
    totalAmount: int.tryParse(json['total_amount']?.toString() ?? '0') ?? 0,
  );

  double get totalAmountRupees => totalAmount / 100;
}

class CustomerPaymentOrder {
  final String orderId;
  final int amount;
  final String currency;
  final String keyId;

  CustomerPaymentOrder({
    required this.orderId,
    required this.amount,
    required this.currency,
    required this.keyId,
  });

  factory CustomerPaymentOrder.fromJson(Map<String, dynamic> json) => CustomerPaymentOrder(
    orderId:  json['order_id'] ?? '',
    amount:   int.tryParse(json['amount']?.toString() ?? '0') ?? 0,
    currency: json['currency'] ?? 'INR',
    keyId:    json['key_id']   ?? '',
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

// ============================================================================
// INVITE CODE MODELS
// ============================================================================

class InviteCodeResult {
  final String code;
  final String displayId;
  final String type;           // 'staff' | 'member'
  final String? trainerRole;   // 'staff' | 'admin'
  final int expiresInDays;
  final String? placeholderName;

  InviteCodeResult({
    required this.code,
    required this.displayId,
    required this.type,
    this.trainerRole,
    this.expiresInDays = 7,
    this.placeholderName,
  });

  factory InviteCodeResult.fromJson(Map<String, dynamic> json) => InviteCodeResult(
    code:            json['code']             ?? '',
    displayId:       json['display_id']       ?? '',
    type:            json['type']             ?? '',
    trainerRole:     json['trainer_role'],
    expiresInDays:   json['expires_in_days']  ?? 7,
    placeholderName: json['placeholder_name'],
  );
}

class InviteCodeInfo {
  final String code;
  final String type;
  final String displayId;
  final String? trainerRole;
  final String gymName;
  final String? placeholderName;

  InviteCodeInfo({
    required this.code,
    required this.type,
    required this.displayId,
    this.trainerRole,
    required this.gymName,
    this.placeholderName,
  });

  factory InviteCodeInfo.fromJson(Map<String, dynamic> json) => InviteCodeInfo(
    code:            json['code']             ?? '',
    type:            json['type']             ?? '',
    displayId:       json['display_id']       ?? '',
    trainerRole:     json['trainer_role'],
    gymName:         json['gym_name']         ?? '',
    placeholderName: json['placeholder_name'],
  );
}
