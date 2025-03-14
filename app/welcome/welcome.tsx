import React from "react";
import { Link } from "react-router";

interface WelcomeProps {
  message?: string;
}

export function Welcome({ message }: WelcomeProps) {
  return (
    <main className="px-4 py-10 sm:px-6 sm:py-28 lg:px-8 xl:px-28 xl:py-32">
      <div className="flex justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
            Home Assistant AI
          </div>
        </div>
      </div>
      <div className="mx-auto mt-10 max-w-2xl text-center">
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl lg:text-6xl">
          Home Assistant Enhanced Chat Interface
        </h1>
        <p className="mt-6 text-lg leading-8 text-gray-600 dark:text-gray-300">
          A natural language interface for your Home Assistant smart home, 
          enabling seamless control with powerful AI integration.
        </p>
      </div>

      <div className="mx-auto mt-16 max-w-2xl">
        <div className="flex justify-center gap-8">
          <Link
            to="/assistant"
            className="rounded-xl bg-indigo-600 px-6 py-4 text-lg font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          >
            Launch Assistant
          </Link>
          <a
            href="https://home-assistant.io" 
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl bg-gray-200 dark:bg-gray-800 px-6 py-4 text-lg font-semibold text-gray-900 dark:text-white shadow-sm hover:bg-gray-300 dark:hover:bg-gray-700"
          >
            Home Assistant Docs
          </a>
        </div>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8">
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-900">
              <svg className="h-6 w-6 text-indigo-600 dark:text-indigo-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            </div>
            <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-white">Natural Language Control</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              Control your smart home devices with natural language commands. Simply ask to turn lights on, adjust the thermostat, or check your security cameras.
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-900">
              <svg className="h-6 w-6 text-indigo-600 dark:text-indigo-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-white">Camera Analysis</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              AI-powered analysis of your security cameras. Get detailed descriptions of what's happening in your home or yard, with automatic detection of important events.
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-900">
              <svg className="h-6 w-6 text-indigo-600 dark:text-indigo-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
              </svg>
            </div>
            <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-white">Smart Automations</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              Create complex automations with simple commands. Ask the assistant to set up routines, schedules, and conditional actions for your smart home devices.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
