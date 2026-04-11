import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:flutter/foundation.dart' show kIsWeb, defaultTargetPlatform, TargetPlatform;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../models/models.dart';

// In production pass --dart-define=API_URL=https://your-server.com/api
// In dev on Android emulator: --dart-define=API_URL=http://10.0.2.2:3000/api
// In dev on physical device:  --dart-define=API_URL=http://<your-pc-ip>:3000/api
const String _envApiUrl = String.fromEnvironment('API_URL', defaultValue: '');

String get baseUrl {
  if (_envApiUrl.isNotEmpty) return _envApiUrl;
  // Web and iOS simulator both resolve localhost fine
  if (kIsWeb) return 'http://localhost:3000/api';
  if (defaultTargetPlatform == TargetPlatform.android) {
    return 'http://10.0.2.2:3000/api'; // Android emulator → host machine
  }
  return 'http://localhost:3000/api';
}

class ApiService {
  static final ApiService _instance = ApiService._internal();
  
  factory ApiService() {
    return _instance;
  }
  
  ApiService._internal();

  // Called with true on login/token-save, false on logout
  static void Function(bool)? onAuthChanged;

  // Tokens stored securely (Keychain on iOS, Keystore on Android, encrypted IndexedDB on web)
  final _secureStorage = const FlutterSecureStorage(
    webOptions: WebOptions(dbName: 'gymRetentionSecure', publicKey: 'gymRetentionKey'),
  );

  String? _accessToken;
  String? _refreshToken;

  bool get isLoggedIn => _accessToken != null && _accessToken!.isNotEmpty;

  Future<void> loadTokens() async {
    _accessToken = await _secureStorage.read(key: 'access_token');
    _refreshToken = await _secureStorage.read(key: 'refresh_token');
  }

  Future<void> _saveTokens(String accessToken, String refreshToken) async {
    await Future.wait([
      _secureStorage.write(key: 'access_token', value: accessToken),
      _secureStorage.write(key: 'refresh_token', value: refreshToken),
    ]);
    _accessToken = accessToken;
    _refreshToken = refreshToken;
    onAuthChanged?.call(true);
  }

  Map<String, String> _getHeaders() {
    return {
      'Content-Type': 'application/json',
      if (_accessToken != null) 'Authorization': 'Bearer $_accessToken',
    };
  }

  Future<T> _handleResponse<T>(http.Response response, T Function(dynamic) fromJson) async {
    if (response.statusCode == 401) {
      // Token expired, try refresh
      if (_refreshToken != null) {
        final refreshed = await _refreshAccessToken();
        if (!refreshed) {
          throw UnauthorizedException('Session expired');
        }
      }
    }

    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      // Zod returns 'errors' (array), other errors return 'error' (string)
      String message = body['error'] ?? '';
      if (message.isEmpty && body['errors'] is List) {
        message = (body['errors'] as List)
            .map((e) => '${e['field']}: ${e['message']}')
            .join(', ');
      }
      throw ApiException(message.isEmpty ? 'Request failed (${response.statusCode})' : message, response.statusCode);
    }

    final body = jsonDecode(response.body);
    if (body['success'] == false) {
      String message = body['error'] ?? '';
      if (message.isEmpty && body['errors'] is List) {
        message = (body['errors'] as List)
            .map((e) => '${e['field']}: ${e['message']}')
            .join(', ');
      }
      throw ApiException(message.isEmpty ? 'Unknown error' : message, response.statusCode);
    }

    return fromJson(body['data']);
  }

  Future<bool> _refreshAccessToken() async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/auth/refresh'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refresh_token': _refreshToken}),
      );

      if (response.statusCode == 200) {
        final body = jsonDecode(response.body);
        await _saveTokens(body['data']['access_token'], body['data']['refresh_token']);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // ============================================================================
  // AUTHENTICATION ENDPOINTS
  // ============================================================================

  Future<LoginResponse> login({
    required String email,
    required String password,
    required String role,
    String? gymId,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'phone_or_email': email,
        'password': password,
        'role': role,
        if (gymId != null) 'gym_id': gymId,
      }),
    );

    final result = await _handleResponse(response, (data) => LoginResponse.fromJson(data));
    await _saveTokens(result.accessToken, result.refreshToken);
    // Save user info for screens to use
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('user_id', result.user.id);
    await prefs.setString('gym_id', result.user.gymId);
    await prefs.setString('user_role', result.user.role);
    return result;
  }

  Future<void> logout() async {
    await Future.wait([
      _secureStorage.delete(key: 'access_token'),
      _secureStorage.delete(key: 'refresh_token'),
    ]);
    _accessToken = null;
    _refreshToken = null;
    onAuthChanged?.call(false);
  }

  Future<void> forgotPassword({required String email}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/forgot-password'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email}),
    );
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }

  Future<void> resetPassword({required String token, required String newPassword}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/reset-password'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'token': token, 'new_password': newPassword}),
    );
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }

  Future<void> sendOtp({required String email}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/send-otp'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email}),
    );
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw ApiException(body['error'] ?? 'Failed to send OTP', response.statusCode);
    }
  }

  Future<void> verifyOtp({required String email, required String code}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/verify-otp'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email, 'code': code}),
    );
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw ApiException(body['error'] ?? 'Invalid OTP', response.statusCode);
    }
  }

  // ============================================================================
  // GYM ENDPOINTS
  // ============================================================================

  Future<GymRegistrationResponse> registerGym({
    required String gymName,
    required String ownerName,
    required String phone,
    required String email,
    required String address,
    required String ownerPassword,
    required String ownerEmail,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/gyms/register'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'gym_name': gymName,
        'owner_name': ownerName,
        'phone': phone,
        'email': email,
        'address': address,
        'owner_password': ownerPassword,
        'owner_email': ownerEmail,
      }),
    );

    if (response.statusCode == 200 || response.statusCode == 201) {
      final data = jsonDecode(response.body);
      await _saveTokens(data['accessToken'] ?? '', data['refreshToken'] ?? '');
    }
    return _handleResponse(response, (data) => GymRegistrationResponse.fromJson(data));
  }

  Future<GymSubscriptionResponse> getGymSubscription(String gymId) async {
    final response = await http.get(
      Uri.parse('$baseUrl/gyms/$gymId/subscription'),
      headers: _getHeaders(),
    );
    return _handleResponse(response, (data) => GymSubscriptionResponse.fromJson(data));
  }

  Future<RazorpayOrderResponse> createBillingOrder({
    required String gymId,
    required String plan,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/gyms/$gymId/billing/create-order'),
      headers: _getHeaders(),
      body: jsonEncode({'plan': plan}),
    );
    return _handleResponse(response, (data) => RazorpayOrderResponse.fromJson(data));
  }

  Future<Map<String, dynamic>> verifyPayment({
    required String gymId,
    required String razorpayOrderId,
    required String razorpayPaymentId,
    required String razorpaySignature,
    required String plan,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/gyms/$gymId/billing/verify-payment'),
      headers: _getHeaders(),
      body: jsonEncode({
        'razorpay_order_id': razorpayOrderId,
        'razorpay_payment_id': razorpayPaymentId,
        'razorpay_signature': razorpaySignature,
        'plan': plan,
      }),
    );
    return _handleResponse(response, (data) => data as Map<String, dynamic>);
  }

  // ============================================================================
  // MEMBERS ENDPOINTS
  // ============================================================================

  Future<MembersResponse> getMembers({
    int page = 1,
    int limit = 10,
    String? status,
  }) async {
    final params = <String, String>{
      'page': page.toString(),
      'limit': limit.toString(),
      if (status != null) 'status': status,
    };
    final uri = Uri.parse('$baseUrl/members').replace(queryParameters: params);
    final response = await http.get(uri, headers: _getHeaders());

    return _handleResponse(response, (data) => MembersResponse.fromJson(data));
  }

  Future<Member> createMember({
    required String name,
    required String phone,
    String? email,
    String? lastVisitDate,
    required String membershipExpiryDate,
    required double planFee,
    required String assignedTrainerId,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/members'),
      headers: _getHeaders(),
      body: jsonEncode({
        'name': name,
        'phone': phone,
        if (email != null && email.isNotEmpty) 'email': email,
        if (lastVisitDate != null) 'last_visit_date': lastVisitDate,
        'membership_expiry_date': membershipExpiryDate,
        'plan_fee': planFee,
        'assigned_trainer_id': assignedTrainerId,
      }),
    );

    return _handleResponse(response, (data) => Member.fromJson(data));
  }

  Future<Member> updateMember({
    required String memberId,
    required String name,
    required String phone,
    required String email,
    required String membershipExpiryDate,
    required double planFee,
  }) async {
    final response = await http.put(
      Uri.parse('$baseUrl/members/$memberId'),
      headers: _getHeaders(),
      body: jsonEncode({
        'name': name,
        'phone': phone,
        'email': email,
        'membership_expiry_date': membershipExpiryDate,
        'plan_fee': planFee,
      }),
    );

    return _handleResponse(response, (data) => Member.fromJson(data));
  }

  Future<void> deleteMember(String memberId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/members/$memberId'),
      headers: _getHeaders(),
    );

    await _handleResponse(response, (_) => null);
  }

  // ============================================================================
  // TRAINERS ENDPOINTS
  // ============================================================================

  Future<TrainersResponse> getTrainers() async {
    final response = await http.get(
      Uri.parse('$baseUrl/trainers'),
      headers: _getHeaders(),
    );
    return _handleResponse(response, (data) => TrainersResponse.fromJson(data));
  }

  Future<Trainer> createTrainer({
    required String name,
    required String phone,
    required String email,
    required String password,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/trainers'),
      headers: _getHeaders(),
      body: jsonEncode({
        'name': name,
        'phone': phone,
        'email': email,
        'password': password,
      }),
    );
    return _handleResponse(response, (data) => Trainer.fromJson(data));
  }

  Future<Trainer> getMyTrainerProfile() async {
    await loadTokens();
    final response = await http.get(
      Uri.parse('$baseUrl/trainers/me'),
      headers: _getHeaders(),
    );
    return _handleResponse(response, (data) => Trainer.fromJson(data));
  }

  Future<Trainer> updateTrainer({
    required String trainerId,
    required String name,
    required String phone,
  }) async {
    final response = await http.patch(
      Uri.parse('$baseUrl/trainers/$trainerId'),
      headers: _getHeaders(),
      body: jsonEncode({'name': name, 'phone': phone}),
    );
    return _handleResponse(response, (data) => Trainer.fromJson(data));
  }

  Future<void> assignMembersToTrainer({
    required String trainerId,
    required List<String> memberIds,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/trainers/$trainerId/assign-members'),
      headers: _getHeaders(),
      body: jsonEncode({'member_ids': memberIds}),
    );
    await _handleResponse(response, (_) => null);
  }

  Future<void> deleteTrainer(String trainerId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/trainers/$trainerId'),
      headers: _getHeaders(),
    );
    await _handleResponse(response, (_) => null);
  }

  // ============================================================================
  // TASKS ENDPOINTS
  // ============================================================================

  Future<Task> createTask({
    required String memberId,
    required String taskType,
    String? assignedTrainerId,
    String? notes,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/tasks'),
      headers: _getHeaders(),
      body: jsonEncode({
        'member_id': memberId,
        'task_type': taskType,
        if (assignedTrainerId != null) 'assigned_trainer_id': assignedTrainerId,
        if (notes != null && notes.isNotEmpty) 'notes': notes,
      }),
    );

    return _handleResponse(response, (data) => Task.fromJson(data));
  }

  Future<TasksResponse> getTasks({String? status, String? trainerId, String? memberId}) async {
    final params = <String, String>{};
    if (status != null) params['status'] = status;
    if (trainerId != null) params['trainer_id'] = trainerId;
    if (memberId != null) params['member_id'] = memberId;
    final uri = Uri.parse('$baseUrl/tasks').replace(queryParameters: params.isEmpty ? null : params);

    final response = await http.get(uri, headers: _getHeaders());

    return _handleResponse(response, (data) => TasksResponse.fromJson(data));
  }

  Future<Task> completeTask({
    required String taskId,
    required String outcome,
    String? notes,
  }) async {
    final response = await http.patch(
      Uri.parse('$baseUrl/tasks/$taskId'),
      headers: _getHeaders(),
      body: jsonEncode({
        'outcome': outcome,
        'notes': notes,
      }),
    );

    return _handleResponse(response, (data) => Task.fromJson(data));
  }

  // ============================================================================
  // ATTENDANCE ENDPOINTS
  // ============================================================================

  Future<void> markAttendance({
    required String memberId,
    required String visitDate,
    String? checkInTime,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/attendance'),
      headers: _getHeaders(),
      body: jsonEncode({
        'member_id': memberId,
        'visit_date': visitDate,
        if (checkInTime != null) 'check_in_time': checkInTime,
      }),
    );

    await _handleResponse(response, (_) => null);
  }

  Future<AttendanceResponse> getAttendance({String? date}) async {
    final uri = Uri.parse('$baseUrl/attendance').replace(
      queryParameters: date != null ? {'date': date} : null,
    );
    final response = await http.get(uri, headers: _getHeaders());
    return _handleResponse(response, (data) => AttendanceResponse.fromJson(data));
  }

  // ============================================================================
  // DASHBOARD ENDPOINTS
  // ============================================================================

  Future<DashboardKPIs> getDashboardKPIs() async {
    final response = await http.get(
      Uri.parse('$baseUrl/dashboard/kpis'),
      headers: _getHeaders(),
    );

    return _handleResponse(response, (data) => DashboardKPIs.fromJson(data));
  }

  Future<RevenueResponse> getRevenue() async {
    final response = await http.get(
      Uri.parse('$baseUrl/revenue'),
      headers: _getHeaders(),
    );

    return _handleResponse(response, (data) => RevenueResponse.fromJson(data));
  }

  // ============================================================================
  // DATA EXPORT & GDPR ENDPOINTS
  // ============================================================================

  /// Returns CSV bytes for all members. Caller should trigger a browser download.
  Future<List<int>> exportMembersCsv() async {
    final response = await http.get(
      Uri.parse('$baseUrl/members/export'),
      headers: _getHeaders(),
    );
    if (response.statusCode == 401) throw UnauthorizedException('Session expired');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw ApiException(body['error'] ?? 'Export failed', response.statusCode);
    }
    return response.bodyBytes.toList();
  }

  Future<void> deleteMemberData(String memberId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/members/$memberId/data'),
      headers: _getHeaders(),
    );
    if (response.statusCode == 401) throw UnauthorizedException('Session expired');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw ApiException(body['error'] ?? 'Delete failed', response.statusCode);
    }
  }

  // ============================================================================
  // ADMIN ENDPOINTS
  // ============================================================================

  Map<String, String> _adminHeaders(String secret) => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $secret',
  };

  Future<List<AdminGym>> adminGetGyms(String secret) async {
    final response = await http.get(
      Uri.parse('$baseUrl/admin/gyms'),
      headers: _adminHeaders(secret),
    );
    if (response.statusCode == 401) throw Exception('Invalid admin secret');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
    final body = jsonDecode(response.body);
    return (body['data']['gyms'] as List).map((g) => AdminGym.fromJson(g)).toList();
  }

  Future<void> adminSuspendGym(String secret, String gymId) async {
    final response = await http.post(
      Uri.parse('$baseUrl/admin/gyms/$gymId/suspend'),
      headers: _adminHeaders(secret),
    );
    if (response.statusCode == 401) throw Exception('Invalid admin secret');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }

  Future<void> adminReactivateGym(String secret, String gymId) async {
    final response = await http.post(
      Uri.parse('$baseUrl/admin/gyms/$gymId/reactivate'),
      headers: _adminHeaders(secret),
    );
    if (response.statusCode == 401) throw Exception('Invalid admin secret');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }

  Future<void> adminConvertGym(String secret, String gymId, int months) async {
    final response = await http.post(
      Uri.parse('$baseUrl/admin/gyms/$gymId/convert'),
      headers: _adminHeaders(secret),
      body: jsonEncode({'months': months}),
    );
    if (response.statusCode == 401) throw Exception('Invalid admin secret');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }
}

// ============================================================================
// CUSTOM EXCEPTIONS
// ============================================================================

class ApiException implements Exception {
  final String message;
  final int statusCode;

  ApiException(this.message, this.statusCode);

  @override
  String toString() => message;
}

class UnauthorizedException extends ApiException {
  UnauthorizedException(String message) : super(message, 401);
}

// ============================================================================
// API SERVICE PROVIDER
// ============================================================================

final apiServiceProvider = Provider((ref) {
  return ApiService();
});
