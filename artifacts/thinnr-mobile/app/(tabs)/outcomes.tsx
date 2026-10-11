/**
 * The staff Outcomes tab was retired before the first store build (outcome
 * numbers live on the web Overview and office Insights). The route stays so
 * old deep links and bookmarks land on the Overview instead of a 404.
 */
import React from 'react';
import { Redirect } from 'expo-router';

export default function OutcomesRedirect() {
  return <Redirect href="/" />;
}
