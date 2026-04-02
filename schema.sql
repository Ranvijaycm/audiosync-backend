-- AudioSync Database Schema
-- Run this in MySQL Workbench to set up the database

CREATE DATABASE IF NOT EXISTS audiosync;
USE audiosync;

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Rooms table
CREATE TABLE IF NOT EXISTS rooms (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(6) NOT NULL UNIQUE,
  created_by INT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Room users (listeners) table
CREATE TABLE IF NOT EXISTS room_users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  room_id INT NOT NULL,
  user_id INT NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_room_user (room_id, user_id)
);

-- Queue table
CREATE TABLE IF NOT EXISTS queue (
  id INT PRIMARY KEY AUTO_INCREMENT,
  room_id INT NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  track_name VARCHAR(255) NOT NULL,
  artist VARCHAR(255) NOT NULL,
  added_by VARCHAR(255) NOT NULL,
  order_index INT NOT NULL DEFAULT 0,
  is_played BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);