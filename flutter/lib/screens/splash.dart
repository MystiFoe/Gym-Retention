import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:gym_fitness_app/services/api_service.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../main.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final api = ApiService();

    // 🔥 load tokens
    await api.loadTokens();

    final prefs = await SharedPreferences.getInstance();
    final role = prefs.getString('user_role') ?? '';

    // 🔥 update auth state
    authNotifier.update(api.isLoggedIn, role: role);

    await Future.delayed(const Duration(milliseconds: 300)); // smooth UX

    if (!mounted) return;

    // 🔥 navigate based on login
    if (api.isLoggedIn) {
      if (role == 'trainer') {
        context.go(RoutePaths.trainerDashboard);
      } else {
        context.go(RoutePaths.ownerDashboard);
      }
    } else {
      context.go(RoutePaths.login);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(child:  Container(
        width: 80,
        height: 80,
        decoration: BoxDecoration(
          color: const Color(0xFF2196F3).withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(20),
        ),
        child: const Icon(
          Icons.fitness_center,
          size: 50,
          color: Color(0xFF2196F3),
        ),
      ),),
    );
  }
}
