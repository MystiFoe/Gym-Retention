-- Migration: Add assigned_trainer_id to members table
-- Run this in pgAdmin on the gym_retention database

ALTER TABLE members ADD COLUMN IF NOT EXISTS assigned_trainer_id UUID REFERENCES trainers(id) ON DELETE SET NULL;
