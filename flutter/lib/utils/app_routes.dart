import 'package:go_router/go_router.dart';
import 'package:gym_fitness_app/main.dart';
import 'package:gym_fitness_app/models/models.dart';
import 'package:gym_fitness_app/screens/admin_screen.dart';
import 'package:gym_fitness_app/screens/attendance_screen.dart';
import 'package:gym_fitness_app/screens/forgot_password_screen.dart';
import 'package:gym_fitness_app/screens/email_otp_registration_screen.dart';
import 'package:gym_fitness_app/screens/business_registration_screen.dart';
import 'package:gym_fitness_app/screens/login_screen.dart';
import 'package:gym_fitness_app/screens/customer_attendance_screen.dart';
import 'package:gym_fitness_app/screens/customer_dashboard_screen.dart';
import 'package:gym_fitness_app/screens/customers_screen.dart';
import 'package:gym_fitness_app/screens/owner_dash_board_home_screen.dart';
import 'package:gym_fitness_app/screens/phone_otp_screen.dart';
import 'package:gym_fitness_app/screens/reset_password_screen.dart';
import 'package:gym_fitness_app/screens/revenue_screen.dart';
import 'package:gym_fitness_app/screens/splash.dart';
import 'package:gym_fitness_app/screens/subscription_screen.dart';
import 'package:gym_fitness_app/screens/tasks_screen.dart';
import 'package:gym_fitness_app/screens/staff_dashboard_screen.dart';
import 'package:gym_fitness_app/screens/staff_screen.dart';

import 'app_utils.dart';

class AppRoutes {


  static final GoRouter router = GoRouter(
    navigatorKey: AppUtils.navigatorKey,
    initialLocation: RoutePaths.splash,
    refreshListenable: authNotifier,

    redirect: (context, state) {
      final loggedIn = authNotifier.isLoggedIn;
      final role = authNotifier.role;
      final loc = state.matchedLocation;

      // Admin routes bypass all auth checks — redirect to standalone HTML page on web
      if (loc.startsWith(RoutePaths.admin) || loc == '/admin.html') return null;

      // Still loading auth state — wait at splash
      if (loggedIn == null) return RoutePaths.splash;

      // Routes that unauthenticated users are allowed to visit freely
      // (login, registration flow, forgot/reset password, OTP screens)
      final isPublic =
          loc == RoutePaths.splash ||
          loc.startsWith(RoutePaths.login) ||
          loc.startsWith(RoutePaths.register) ||   // covers /register AND /register/verify-email
          loc.startsWith(RoutePaths.forgotPassword) ||
          loc.startsWith(RoutePaths.resetPassword) ||
          loc.startsWith(RoutePaths.phoneOtp) ||
          loc.startsWith(RoutePaths.admin);

      // Not logged in and trying to access a protected route → send to login
      if (!loggedIn && !isPublic) return RoutePaths.login;

      // Already logged in and on a public/auth route → send to dashboard
      if (loggedIn && isPublic && loc != RoutePaths.admin) {
        if (role == 'trainer') return RoutePaths.trainerDashboard;
        if (role == 'member') return RoutePaths.memberDashboard;
        return RoutePaths.ownerDashboard;
      }

      return null; // no redirect — stay on current route
    },

    routes: <RouteBase>[
      GoRoute(
        name: RouteNames.login,
        path: RoutePaths.login,
        builder: (context, state) => const LoginScreen(),
      ),

      GoRoute(
        name: RouteNames.register,
        path: RoutePaths.register,
        builder: (context, state) => const GymRegistrationScreen(),
      ),

      GoRoute(
        name: RouteNames.forgotPassword,
        path: RoutePaths.forgotPassword,
        builder: (context, state) => const ForgotPasswordScreen(),
      ),

      GoRoute(
        name: RouteNames.resetPassword,
        path: RoutePaths.resetPassword,
        builder: (context, state) => ResetPasswordScreen(
          token: state.queryParameters['token'] ?? '',
        ),
      ),
      GoRoute(
        path: RoutePaths.splash,
        builder: (context, state) => const SplashScreen(),
      ),

      GoRoute(
        name: RouteNames.registerVerifyEmail,
        path: RoutePaths.registerVerifyEmail,
        builder: (context, state) {
          final extra      = state.extra as Map<String, dynamic>?;
          final pendingId  = extra?['pendingId']  as String? ?? '';
          final ownerEmail = extra?['ownerEmail'] as String? ?? '';
          return EmailOtpRegistrationScreen(
            pendingId:  pendingId,
            ownerEmail: ownerEmail,
          );
        },
      ),

      GoRoute(
        name: RouteNames.phoneOtp,
        path: RoutePaths.phoneOtp,
        builder: (context, state) {
          final extra     = state.extra as Map<String, dynamic>?;
          final modeStr   = extra?['mode']      as String? ?? 'login';
          final role      = extra?['role']      as String? ?? 'owner';
          final pendingId = extra?['pendingId'] as String? ?? '';
          final businessPhone = extra?['businessPhone'] as String? ?? '';
          final mode = switch (modeStr) {
            'forgotPassword'          => OtpMode.forgotPassword,
            'registrationPhoneVerify' => OtpMode.registrationPhoneVerify,
            _                         => OtpMode.login,
          };
          return PhoneOtpScreen(
            mode:          mode,
            role:          role,
            pendingId:     pendingId,
            businessPhone: businessPhone,
          );
        },
      ),

      GoRoute(
        name: RouteNames.subscription,
        path: RoutePaths.subscription,
        builder: (context, state) => const SubscriptionScreen(),
      ),

      GoRoute(
        name: RouteNames.ownerDashboard,
        path: RoutePaths.ownerDashboard,
        builder: (context, state) => const OwnerDashBoardHomeScreen(),
      ),

      GoRoute(
        name: RouteNames.ownerMembers,
        path: RoutePaths.ownerMembers,
        builder: (context, state) => const MembersScreen(),
      ),

      GoRoute(
        name: RouteNames.ownerTasks,
        path: RoutePaths.ownerTasks,
        builder: (context, state) => const TasksScreen(),
      ),

      GoRoute(
        name: RouteNames.ownerAttendance,
        path: RoutePaths.ownerAttendance,
        builder: (context, state) => const AttendanceScreen(),
      ),

      GoRoute(
        name: RouteNames.ownerRevenue,
        path: RoutePaths.ownerRevenue,
        builder: (context, state) => const RevenueScreen(),
      ),

      GoRoute(
        name: RouteNames.ownerTrainers,
        path: RoutePaths.ownerTrainers,
        builder: (context, state) => const TrainersScreen(),
      ),

      GoRoute(
        name: RouteNames.trainerDashboard,
        path: RoutePaths.trainerDashboard,
        builder: (context, state) => const TrainerDashboardScreen(),
      ),

      GoRoute(
        name: RouteNames.memberDashboard,
        path: RoutePaths.memberDashboard,
        builder: (context, state) => const MemberDashboardScreen(),
      ),

      GoRoute(
        name: RouteNames.admin,
        path: RoutePaths.admin,
        builder: (context, state) => const AdminScreen(),
      ),

      // Handle /admin.html typed with hash — redirects to /admin which triggers AdminScreen redirect
      GoRoute(
        path: '/admin.html',
        redirect: (context, state) => RoutePaths.admin,
      ),

      // Customer attendance calendar – receives a Customer via extra
      GoRoute(
        name: RouteNames.memberAttendance,
        path: RoutePaths.memberAttendance,
        builder: (context, state) {
          final member = state.extra as Customer;
          return MemberAttendanceScreen(member: member);
        },
      ),
    ],
  );

  // 🔹 Navigation helpers
  static void pop([dynamic result]) {
    if (router.canPop()) {
      router.pop(result);
    }
  }

  static Future<void> pushNamed(String name, {dynamic arguments}) async {
    await router.pushNamed(name, extra: arguments);
  }

  static void pushAndRemoveUntil(String name, {dynamic arguments}) {
    router.goNamed(name, extra: arguments);
  }
}



class RouteNames {
  static const login = 'login';
  static const register = 'register';
  static const registerVerifyEmail = 'registerVerifyEmail';
  static const forgotPassword = 'forgotPassword';
  static const resetPassword = 'resetPassword';
  static const phoneOtp = 'phoneOtp';
  static const subscription = 'subscription';

  static const ownerDashboard = 'ownerDashboard';
  static const ownerMembers = 'ownerMembers';
  static const ownerTasks = 'ownerTasks';
  static const ownerAttendance = 'ownerAttendance';
  static const ownerRevenue = 'ownerRevenue';
  static const ownerTrainers = 'ownerTrainers';

  static const trainerDashboard = 'trainerDashboard';
  static const memberDashboard = 'memberDashboard';

  static const admin = 'admin';
  static const memberAttendance = 'memberAttendance';
}
class RoutePaths {
  static const login = '/login';
  static const register = '/register';
  static const registerVerifyEmail = '/register/verify-email';
  static const forgotPassword = '/forgot-password';
  static const resetPassword = '/reset-password';
  static const phoneOtp = '/phone-otp';
  static const subscription = '/subscription';
  static const splash = '/splash';

  static const ownerDashboard = '/owner/dashboard';
  static const ownerMembers = '/owner/members';
  static const ownerTasks = '/owner/tasks';
  static const ownerAttendance = '/owner/attendance';
  static const ownerRevenue = '/owner/revenue';
  static const ownerTrainers = '/owner/trainers';

  static const trainerDashboard = '/trainer/dashboard';
  static const memberDashboard = '/member/dashboard';

  static const admin = '/admin';
  static const memberAttendance = '/member-attendance';
}
// routes: <RouteBase>[
// GoRoute(
// name: RouteNames.login,
// path: RoutePaths.login,
// builder: (context, state) => const LoginScreen(),
// ),
//
// GoRoute(
// name: RouteNames.register,
// path: RoutePaths.register,
// builder: (context, state) => const GymRegistrationScreen(),
// ),
//
// GoRoute(
// name: RouteNames.forgotPassword,
// path: RoutePaths.forgotPassword,
// builder: (context, state) => const ForgotPasswordScreen(),
// ),
//
// GoRoute(
// name: RouteNames.resetPassword,
// path: RoutePaths.resetPassword,
// builder: (context, state) => ResetPasswordScreen(
// token: state.queryParameters['token'] ?? '',
// ),
// ),
//
// GoRoute(
// name: RouteNames.subscription,
// path: RoutePaths.subscription,
// builder: (context, state) => const SubscriptionScreen(),
// ),
//
// GoRoute(
// name: RouteNames.ownerDashboard,
// path: RoutePaths.ownerDashboard,
// builder: (context, state) => const OwnerDashboardScreen(),
// ),
//
// GoRoute(
// name: RouteNames.ownerMembers,
// path: RoutePaths.ownerMembers,
// builder: (context, state) => const MembersScreen(),
// ),
//
// GoRoute(
// name: RouteNames.ownerTasks,
// path: RoutePaths.ownerTasks,
// builder: (context, state) => const TasksScreen(),
// ),
//
// GoRoute(
// name: RouteNames.ownerAttendance,
// path: RoutePaths.ownerAttendance,
// builder: (context, state) => const AttendanceScreen(),
// ),
//
// GoRoute(
// name: RouteNames.ownerRevenue,
// path: RoutePaths.ownerRevenue,
// builder: (context, state) => const RevenueScreen(),
// ),
//
// GoRoute(
// name: RouteNames.ownerTrainers,
// path: RoutePaths.ownerTrainers,
// builder: (context, state) => const TrainersScreen(),
// ),
//
// GoRoute(
// name: RouteNames.trainerDashboard,
// path: RoutePaths.trainerDashboard,
// builder: (context, state) => const TrainerDashboardScreen(),
// ),
//
// GoRoute(
// name: RouteNames.memberDashboard,
// path: RoutePaths.memberDashboard,
// builder: (context, state) => const MemberDashboardScreen(),
// ),
//
// GoRoute(
// name: RouteNames.admin,
// path: RoutePaths.admin,
// builder: (context, state) => const AdminScreen(),
// ),
// ],